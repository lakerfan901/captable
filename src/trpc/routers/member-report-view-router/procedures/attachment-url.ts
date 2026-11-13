import { TRPCError } from "@trpc/server";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { assertKeyReadableByCompany } from "@/server/tenant-ownership";
import { withoutAuth } from "@/trpc/api/trpc";
import { visibleAttachmentWhere } from "../access";
import { ZReportAttachmentUrlSchema } from "../schema";
import { resolveOpenRecipient } from "./resolve";

// memberReportView.attachmentUrl (03-governance.md G12, A6). Public; an OK
// link only.
//
// Serves exactly one file: an attachment of THIS recipient's own report
// (report and company from the recipient row) that is shared or private to
// THIS recipient's holder (TAX_K1: own files only). Anything else — another
// holder's K-1, a file of another report, an unknown id — is the same
// message-less NOT_FOUND. The bucket key must be in the report company's
// namespace. Only a 10-minute presigned GET URL is returned (signed for that
// one object); the storage key and bucket id are never returned.
// A mutation (POST) so the token never travels in a URL.

const notFound = (): never => {
  throw new TRPCError({ code: "NOT_FOUND" });
};

export const attachmentUrlProcedure = withoutAuth
  .input(ZReportAttachmentUrlSchema)
  .mutation(async ({ ctx, input }) => {
    const { recipient, report, company } = await resolveOpenRecipient(
      ctx.db,
      input.token,
      new Date(),
    );

    const attachment = await ctx.db.memberReportAttachment.findFirst({
      where: {
        id: input.attachmentId,
        reportId: recipient.reportId,
        companyId: report.companyId,
        ...visibleAttachmentWhere(recipient.stakeholderId, report.type),
      },
      select: { bucketId: true },
    });
    if (!attachment) return notFound();

    const bucket = await ctx.db.bucket.findUnique({
      where: { id: attachment.bucketId },
      select: { key: true, mimeType: true, name: true },
    });
    if (!bucket) return notFound();
    // Throws NOT_FOUND unless the key is in the company's namespace.
    assertKeyReadableByCompany(bucket.key, {
      id: company.id,
      publicId: company.publicId,
    });

    // Served with the stored type: PDF and images inline, the rest as a
    // download (src/lib/inline-content-type.ts).
    const { url } = await getPresignedGetUrl(bucket.key, {
      mimeType: bucket.mimeType,
      name: bucket.name,
    });
    return { url };
  });
