import { TRPCError } from "@trpc/server";
import { TAG } from "@/lib/tags";
import { Audit } from "@/server/audit";
import {
  deleteObject,
  getPresignedPutUrl,
  headObject,
} from "@/server/file-uploads";
import {
  countW9Uploads,
  loadW9Packet,
  lockTemplate,
  resolveW9Token,
  W9_FILE_REFUSED,
  W9_LIMIT_REACHED,
  W9_LINK_INVALID,
  W9_MAX_BYTES,
  W9_MAX_UPLOADS,
  w9KeyContentType,
  w9UploadFileName,
} from "@/server/llc/admission";
import { withoutAuth } from "@/trpc/api/trpc";
import { createBucketHandler } from "@/trpc/routers/bucket-router/procedures/create-bucket";
import { createDocumentHandler } from "@/trpc/routers/document-router/procedures/create-document";
import {
  ZodW9CompleteSchema,
  ZodW9InfoSchema,
  ZodW9UploadUrlSchema,
} from "../schema";

// Public W-9 upload (01-foundation.md F12, B26). No login: the emailed W-9
// link is the only credential.
//
// - The token is an HS256 JWT with `p: "w9"`, one packet and one investor
//   recipient, expiring after 30 days (`resolveW9Token`); the packet must
//   still be a SUBSCRIPTION packet (PENDING or COMPLETE) whose investor has
//   signed. Every failure is the same detail-free FORBIDDEN.
// - All three procedures are MUTATIONS (POST body), so the token never
//   appears in a URL, and none of them echoes the token, a storage key of
//   another packet or a download URL. Nothing here logs the token, the key
//   or the file name; storage errors are replaced by a generic error with no
//   cause (the RSC caller logs every error).
// - The upload URL is a presigned PUT into the PRIVATE bucket under a
//   server-chosen key (`<company>/w9-docs-<packet id>-<random><ext>`; the
//   client's file name is not used), valid 10 minutes, with Content-Type and
//   Content-Length signed: the store refuses any other type or size.
// - `w9Complete` accepts only a key of THIS packet, checks the stored object
//   (size and type) and deletes anything else, and registers it under the
//   template row lock with the per-packet cap re-counted.
// - `w9-docs` is not a browser upload prefix (src/lib/upload-authorization.ts
//   is unchanged); the W-9 can be opened only by team members with
//   `documents: read` through the existing presigned GET.

const storageUnavailable = () =>
  new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The upload could not be processed. Please try again.",
  });

/** Runs a storage call; any storage error becomes a generic error without the original (it names the key). */
async function storage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw storageUnavailable();
  }
}

export const w9InfoProcedure = withoutAuth
  .input(ZodW9InfoSchema)
  .mutation(async ({ ctx, input }) => {
    const packet = await resolveW9Token(ctx.db, input.token);
    const uploaded = await countW9Uploads(ctx.db, packet);
    return {
      companyName: packet.companyName,
      investorName: packet.stakeholderName,
      uploaded,
      remaining: Math.max(0, W9_MAX_UPLOADS - uploaded),
    };
  });

export const w9UploadUrlProcedure = withoutAuth
  .input(ZodW9UploadUrlSchema)
  .mutation(async ({ ctx, input }) => {
    const packet = await resolveW9Token(ctx.db, input.token);
    const uploaded = await countW9Uploads(ctx.db, packet);
    if (uploaded >= W9_MAX_UPLOADS) {
      throw new TRPCError({ code: "BAD_REQUEST", message: W9_LIMIT_REACHED });
    }
    const { url, key } = await storage(() =>
      getPresignedPutUrl({
        contentType: input.contentType,
        fileName: w9UploadFileName(packet.templateId, input.contentType),
        keyPrefix: "w9-docs",
        identifier: packet.companyPublicId,
        bucketMode: "privateBucket",
        signContentType: true,
        contentLength: input.size,
      }),
    );
    return { url, key };
  });

class W9Refusal extends Error {
  constructor(
    message: string,
    readonly deleteUpload: boolean,
  ) {
    super(message);
  }
}

export const w9CompleteProcedure = withoutAuth
  .input(ZodW9CompleteSchema)
  .mutation(async ({ ctx, input }) => {
    const { db, requestIp, userAgent } = ctx;
    const packet = await resolveW9Token(db, input.token);
    const key = input.key;

    // 1. The key must be one this packet's upload URL could have issued.
    //    Nothing outside that namespace is ever read or deleted here.
    const expectedType = w9KeyContentType(key, packet);
    if (expectedType === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This upload does not belong to this link.",
      });
    }

    // 2. Already registered: refuse, and leave the registered object alone.
    const known = await db.bucket.findFirst({
      where: { key },
      select: { id: true },
    });
    if (known) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This file was already received.",
      });
    }

    // 3. The stored object, as the store reports it.
    const head = await storage(() => headObject(key));
    if (head === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The upload was not found. Please upload the file again.",
      });
    }
    const storedType = head.contentType?.split(";")[0]?.trim().toLowerCase();
    if (
      head.size < 1 ||
      head.size > W9_MAX_BYTES ||
      storedType !== expectedType
    ) {
      await storage(() => deleteObject(key));
      throw new TRPCError({ code: "BAD_REQUEST", message: W9_FILE_REFUSED });
    }

    // 4. Register under the template row lock: the token's packet is
    //    re-checked and the cap re-counted, so parallel completes cannot
    //    exceed it or register one key twice.
    try {
      await db.$transaction(async (tx) => {
        await lockTemplate(tx, packet.templateId);
        // First: a concurrent complete of the same key may have registered
        // it while this one waited for the lock. Its object must stay.
        const again = await tx.bucket.findFirst({
          where: { key },
          select: { id: true },
        });
        if (again) {
          throw new W9Refusal("This file was already received.", false);
        }
        const current = await loadW9Packet(tx, {
          templateId: packet.templateId,
          recipientId: packet.recipientId,
        });
        if (!current) throw new W9Refusal(W9_LINK_INVALID, true);
        if ((await countW9Uploads(tx, current)) >= W9_MAX_UPLOADS) {
          throw new W9Refusal(W9_LIMIT_REACHED, true);
        }

        const name = `W-9 — ${current.stakeholderName}`;
        const bucket = await createBucketHandler({
          db: tx,
          input: {
            name,
            key,
            mimeType: expectedType,
            size: head.size,
            tags: [TAG.GENERIC],
          },
          requestIp,
          userAgent,
          user: {
            id: "",
            name: current.stakeholderName,
            companyId: current.companyId,
          },
        });
        const document = await createDocumentHandler({
          db: tx,
          input: { name, bucketId: bucket.id },
          companyId: current.companyId,
          uploaderName: current.stakeholderName,
          stakeholderId: current.stakeholderId,
          kind: "w9",
          requestIp,
          userAgent,
        });
        await Audit.create(
          {
            action: "admission.w9-received",
            companyId: current.companyId,
            actor: { type: "company", id: current.companyId },
            context: { requestIp, userAgent },
            target: [
              { type: "document", id: document.id },
              { type: "stakeholder", id: current.stakeholderId },
              { type: "template", id: current.templateId },
            ],
            summary: `Form W-9 received from ${current.stakeholderName}`,
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof W9Refusal) {
        if (error.deleteUpload) await storage(() => deleteObject(key));
        throw new TRPCError({
          code: error.message === W9_LINK_INVALID ? "FORBIDDEN" : "BAD_REQUEST",
          message: error.message,
        });
      }
      throw error;
    }

    return { ok: true as const };
  });
