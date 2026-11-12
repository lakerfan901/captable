import { generatePublicId } from "@/common/id";
import { Audit } from "@/server/audit";
import type { TPrismaOrTransaction } from "@/server/db";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import {
  withAccessControl,
  type withAuthTrpcContextType,
} from "@/trpc/api/trpc";
import {
  type TypeZodCreateDocumentMutationSchema,
  ZodCreateDocumentMutationSchema,
} from "../schema";

interface createDocumentHandlerOptions
  extends Pick<withAuthTrpcContextType, "requestIp" | "userAgent"> {
  input: TypeZodCreateDocumentMutationSchema;
  companyId: string;
  uploaderName?: string | null | undefined;
  uploaderId?: string;
  /** Files the document on a member (stakeholder of the same company). */
  stakeholderId?: string;
  /** Free document kind key, e.g. "w9". */
  kind?: string;
  db: TPrismaOrTransaction;
}

export const createDocumentHandler = async ({
  db,
  requestIp,
  userAgent,
  input,
  companyId,
  uploaderName,
  uploaderId,
  stakeholderId,
  kind,
}: createDocumentHandlerOptions) => {
  // The bucket (and stakeholder) id may come from the client: refuse another
  // company's rows.
  await assertCompanyOwns(db, companyId, {
    bucketIds: [input.bucketId],
    ...(stakeholderId ? { stakeholderIds: [stakeholderId] } : {}),
  });

  const publicId = generatePublicId();

  const document = await db.document.create({
    data: {
      companyId,
      uploaderId,
      publicId,
      ...input,
      ...(stakeholderId ? { stakeholderId } : {}),
      ...(kind ? { kind } : {}),
    },
  });

  await Audit.create(
    {
      companyId,
      action: "document.created",
      actor: { type: "user", id: "" },
      context: {
        requestIp,
        userAgent,
      },
      target: [{ type: "document", id: document.id }],
      summary: `${uploaderName} uploaded a document: ${document.name}`,
    },
    db,
  );

  return document;
};

export const createDocumentProcedure = withAccessControl
  .input(ZodCreateDocumentMutationSchema)
  .meta({ policies: { documents: { allow: ["create"] } } })
  .mutation(async ({ ctx, input }) => {
    const user = ctx.session.user;
    const {
      userAgent,
      requestIp,
      db,
      membership: { companyId, memberId },
    } = ctx;

    const data = await db.$transaction(async (tx) => {
      const data = await createDocumentHandler({
        input,
        userAgent,
        requestIp,
        db: tx,
        companyId,
        uploaderName: user?.name,
        uploaderId: memberId,
      });

      return data;
    });

    return data;
  });
