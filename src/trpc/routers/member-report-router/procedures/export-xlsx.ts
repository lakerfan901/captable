import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { exportReportXlsx } from "@/server/xlsx/report-export";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportGetSchema } from "../schema";
import { reportNotFound } from "./shared";

// memberReport.exportXlsx (04-investor-portal.md 5.6, 5.7): the Excel
// workbook of a quarterly or annual report of the caller's company, for the
// team. A released report is exported from its frozen figures; a draft from
// its stored figures, marked DRAFT. A mutation (not a query) so the bytes are
// never cached or prefetched. No audit row (5.6).

export const exportXlsxProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberReportGetSchema)
  .mutation(async ({ ctx, input }) => {
    const row = await ctx.db.memberReport.findFirst({
      where: { publicId: input.publicId, companyId: ctx.membership.companyId },
      select: {
        type: true,
        status: true,
        title: true,
        fiscalYear: true,
        fiscalQuarter: true,
        periodStart: true,
        periodEnd: true,
        sentAt: true,
        updatedAt: true,
        figures: true,
        frozenContent: true,
      },
    });
    if (!row) reportNotFound();
    return exportReportXlsx(row, {
      name: ctx.company.name,
      timeZone: ctx.company.timezone || GOVERNANCE_TIME_ZONE,
    });
  });
