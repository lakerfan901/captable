"use server";

/**
 * Browser-callable entry points for presigned S3 URLs.
 *
 * Every export of this file is a public Server Action, so each one
 * authenticates the caller and authorizes the specific object before
 * delegating to the raw helpers in `./file-uploads` (which are server-only
 * and must never be exported from a "use server" module).
 */

import { z } from "zod";
import { RBAC } from "@/lib/rbac";
import { getPermissions } from "@/lib/rbac/access-control";
import {
  authorizeUpload,
  isKeyInCompanyNamespace,
} from "@/lib/upload-authorization";
import { getServerAuthSession } from "./auth";
import { db } from "./db";
import {
  getPresignedGetUrl as getPresignedGetUrlUnchecked,
  getPresignedPutUrl as getPresignedPutUrlUnchecked,
  type getPresignedUrlOptions,
} from "./file-uploads";

const PutInputSchema = z.object({
  contentType: z.string().max(255),
  fileName: z.string().min(1).max(255),
  keyPrefix: z.string().min(1).max(128),
  identifier: z.string().min(1).max(128),
  bucketMode: z.enum(["privateBucket", "publicBucket"]),
});

const KeySchema = z.string().min(1).max(1024);

class UploadAuthorizationError extends Error {
  constructor(message = "Not authorized to access this file") {
    super(message);
    this.name = "UploadAuthorizationError";
  }
}

async function getCaller() {
  const session = await getServerAuthSession();
  const user = session?.user;

  if (!user?.id) {
    throw new UploadAuthorizationError("Not signed in");
  }

  // Don't trust membership claims in the JWT; re-check against the database.
  const member = user.memberId
    ? await db.member.findFirst({
        where: { id: user.memberId, userId: user.id, status: "ACTIVE" },
        select: { company: { select: { id: true, publicId: true } } },
      })
    : null;

  return { session, userId: user.id, company: member?.company ?? null };
}

/**
 * Presigned PUT for the signed-in user.
 * - publicBucket: `company-logos` / `profile-avatars` only, `identifier` must
 *   be the caller's user id, raster image content types only (signed).
 * - privateBucket: caller must be an ACTIVE member; `identifier` must be the
 *   member's company publicId; `keyPrefix` must be an allowed client prefix
 *   or `data-room/<publicId>` of a data room owned by that company.
 */
export const getPresignedPutUrl = async (
  options: Omit<getPresignedUrlOptions, "signContentType">,
) => {
  const input = PutInputSchema.parse(options);
  const caller = await getCaller();

  const result = authorizeUpload(caller, input);
  if (!result.ok) {
    throw new UploadAuthorizationError();
  }

  if (result.dataRoomPublicId) {
    const dataRoom = await db.dataRoom.findFirst({
      where: {
        publicId: result.dataRoomPublicId,
        companyId: caller.company?.id,
      },
      select: { id: true },
    });

    if (!caller.company || !dataRoom) {
      throw new UploadAuthorizationError();
    }
  }

  return getPresignedPutUrlUnchecked({
    contentType: input.contentType,
    fileName: input.fileName,
    identifier: input.identifier,
    keyPrefix: input.keyPrefix as getPresignedUrlOptions["keyPrefix"],
    bucketMode: input.bucketMode,
    // Short-lived regardless of what the browser asks for.
    expiresIn: undefined,
    signContentType: input.bucketMode === "publicBucket",
  });
};

/**
 * Presigned GET for a private-bucket object. The caller must be an ACTIVE
 * member of a company that (a) owns the key's namespace and (b) has the key
 * recorded in a Bucket row linked to one of its Documents or Templates, and
 * their role must grant `documents: read` (as the tRPC document procedures
 * require).
 */
export const getPresignedGetUrl = async (key: string) => {
  const parsedKey = KeySchema.parse(key);
  const { session, company } = await getCaller();

  if (!session || !company || !isKeyInCompanyNamespace(parsedKey, company)) {
    throw new UploadAuthorizationError();
  }

  const { err: permissionError, val: permission } = await getPermissions({
    db,
    session,
  });

  if (permissionError || permission.membership.companyId !== company.id) {
    throw new UploadAuthorizationError();
  }

  const { err: rbacError, val: rbac } = new RBAC()
    .addPolicies({ documents: { allow: ["read"] } })
    .enforce(permission.permissions);

  if (rbacError || !rbac.valid) {
    throw new UploadAuthorizationError();
  }

  const bucket = await db.bucket.findFirst({
    where: {
      key: parsedKey,
      OR: [
        { documents: { some: { companyId: company.id } } },
        { templates: { some: { companyId: company.id } } },
      ],
    },
    select: { id: true },
  });

  if (!bucket) {
    throw new UploadAuthorizationError();
  }

  return getPresignedGetUrlUnchecked(parsedKey);
};
