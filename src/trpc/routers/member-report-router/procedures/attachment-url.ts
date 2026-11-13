import { TRPCError } from "@trpc/server";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { assertKeyReadableByCompany } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportAttachmentUrlSchema } from "../schema";

// memberReport.attachmentUrl (03-governance.md G12): a short-lived (10
// minute) presigned GET URL for one attachment of one report of the
// company. The bucket key must be in the company's namespace. Only the URL
// is returned (never the storage key). A query: the caller is a signed-in
// Manager user and the input carries no credential.

export const attachmentUrlProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberReportAttachmentUrlSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const notFound = () =>
      new TRPCError({ code: "NOT_FOUND", message: "File not found." });

    const report = await ctx.db.memberReport.findFirst({
      where: { publicId: input.publicId, companyId },
      select: { id: true },
    });
    if (!report) throw notFound();
    const attachment = await ctx.db.memberReportAttachment.findFirst({
      where: { id: input.attachmentId, reportId: report.id, companyId },
      select: { bucketId: true },
    });
    if (!attachment) throw notFound();
    const bucket = await ctx.db.bucket.findUnique({
      where: { id: attachment.bucketId },
      select: { key: true },
    });
    if (!bucket) throw notFound();
    assertKeyReadableByCompany(bucket.key, {
      id: ctx.company.id,
      publicId: ctx.company.publicId,
    });
    const { url } = await getPresignedGetUrl(bucket.key);
    return { url };
  });
