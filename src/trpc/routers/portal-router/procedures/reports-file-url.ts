// portal.reports.fileUrl (04-investor-portal.md 5.4, P12, P16, S4, S19;
// package P5a).
//
// Opens one attachment: the report must be visible to the holder (P11) and
// the attachment must belong to that report and company and be one the
// holder may see (P12: shared or private to this holder; TAX_K1 only its
// own), checked again here for the single id. The bucket key must be in the
// company's namespace. Returns only a presigned GET URL valid for 60
// seconds: never the storage key or bucket id. Every miss is the same
// NOT_FOUND. On success one `REPORT_FILE_OPENED` row with targetType
// "memberReportAttachment" and targetId = MemberReportAttachment.id; a
// mutation from the browser, so the stored address is the client's.

import { z } from "zod";
import { PORTAL_FILE_URL_SECONDS } from "@/lib/portal/report-visibility-core";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { writePortalLog } from "@/server/portal/log";
import {
  findVisibleAttachment,
  findVisibleReport,
  ZPortalAttachmentId,
  ZPortalReportId,
} from "@/server/portal/visibility-reports";
import { assertKeyReadableByCompany } from "@/server/tenant-ownership";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export const reportsFileUrlProcedure = investorProcedure
  .input(
    z.object({ reportId: ZPortalReportId, attachmentId: ZPortalAttachmentId }),
  )
  .mutation(async ({ ctx, input }) => {
    const report = await findVisibleReport(ctx.db, ctx.holder, input.reportId);
    const { attachment, bucket } = await findVisibleAttachment(
      ctx.db,
      ctx.holder,
      report,
      input.attachmentId,
    );
    // Throws NOT_FOUND unless the key is in the company's namespace.
    assertKeyReadableByCompany(bucket.key, {
      id: ctx.company.id,
      publicId: ctx.company.publicId,
    });
    // `getPresignedGetUrl` also returns the key: only the URL leaves here.
    const { url } = await getPresignedGetUrl(
      bucket.key,
      { mimeType: bucket.mimeType, name: bucket.name },
      { expiresIn: PORTAL_FILE_URL_SECONDS },
    );
    await writePortalLog(ctx.db, ctx, {
      event: "REPORT_FILE_OPENED",
      targetType: "memberReportAttachment",
      targetId: attachment.id,
      targetName: attachment.name,
    });
    return { url };
  });
