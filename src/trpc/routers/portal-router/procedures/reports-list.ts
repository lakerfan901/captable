// portal.reports.list (04-investor-portal.md 5.4; package P5a).
//
// The reports visible to the holder of `input.access` (P11), newest release
// first. The holder and company come only from `ctx.holder` (P10, G2); the
// rule is `visibleReportWhere` (src/server/portal/visibility-reports.ts).
// A query: it writes no log row (opening a report is logged by markViewed).

import { listVisibleReports } from "@/server/portal/visibility-reports";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export const reportsListProcedure = investorProcedure.query(({ ctx }) =>
  listVisibleReports(ctx.db, ctx.holder),
);
