// portal.reports.markViewed (04-investor-portal.md 5.4, P31; package P5a).
//
// Records that the holder opened a visible report (P11): one
// `REPORT_VIEWED` row in `PortalAccessLog` with targetType "memberReport"
// and targetId = MemberReport.id (the convention `memberReport.get` reads
// for `portalFirstViewedAt` and `canRemove`). A mutation called from the
// browser, so the stored address is the client's (the RSC caller reports
// 127.0.0.1, 2.2). It does not touch the emailed link's view columns on
// `MemberReportRecipient`. A refused call writes nothing.

import { z } from "zod";
import { writePortalLog } from "@/server/portal/log";
import {
  findVisibleReport,
  ZPortalReportId,
} from "@/server/portal/visibility-reports";
import { investorProcedure } from "@/trpc/api/portal-procedure";
import { readFrozenContent } from "../../member-report-router/procedures/shared";

export const reportsMarkViewedProcedure = investorProcedure
  .input(z.object({ reportId: ZPortalReportId }))
  .mutation(async ({ ctx, input }) => {
    const report = await findVisibleReport(ctx.db, ctx.holder, input.reportId);
    await writePortalLog(ctx.db, ctx, {
      event: "REPORT_VIEWED",
      targetType: "memberReport",
      targetId: report.id,
      targetName:
        readFrozenContent(report.frozenContent)?.title ?? report.title,
    });
    return { ok: true as const };
  });
