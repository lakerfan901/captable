// portal.reports.exportXlsx (04-investor-portal.md 5.4, 5.7, P15, S7;
// package P5a, on P7's `exportReportXlsx`).
//
// The Excel workbook of a quarterly or annual report visible to the holder
// (P11), built from the figures frozen at release only; it reads nothing
// about recipients, so it holds no other holder's data. A report that is not
// visible, or is not quarterly or annual, or whose frozen figures cannot be
// read, is the same NOT_FOUND. On success one `REPORT_EXPORTED` row with
// targetType "memberReport" and targetId = MemberReport.id. A mutation, so
// the bytes are never cached or prefetched and the address is the client's.

import { z } from "zod";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { isPortalExportable } from "@/lib/portal/report-visibility-core";
import { writePortalLog } from "@/server/portal/log";
import {
  findVisibleReport,
  reportNotFound,
  ZPortalReportId,
} from "@/server/portal/visibility-reports";
import { exportReportXlsx } from "@/server/xlsx/report-export";
import { investorProcedure } from "@/trpc/api/portal-procedure";
import { readFrozenContent } from "../../member-report-router/procedures/shared";

export const reportsExportXlsxProcedure = investorProcedure
  .input(z.object({ reportId: ZPortalReportId }))
  .mutation(async ({ ctx, input }) => {
    const report = await findVisibleReport(ctx.db, ctx.holder, input.reportId);
    const frozen = readFrozenContent(report.frozenContent);
    if (!isPortalExportable(report.type) || !frozen?.figures) {
      return reportNotFound();
    }
    const file = await exportReportXlsx(report, {
      name: ctx.company.name,
      timeZone: ctx.company.timezone || GOVERNANCE_TIME_ZONE,
    });
    await writePortalLog(ctx.db, ctx, {
      event: "REPORT_EXPORTED",
      targetType: "memberReport",
      targetId: report.id,
      targetName: frozen.title,
    });
    return file;
  });
