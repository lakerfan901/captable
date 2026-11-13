import { figuresFromPeriodData } from "@/lib/governance/report-figures";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportRefreshFiguresSchema } from "../schema";
import { loadPeriodReportInput } from "./period-data";
import {
  auditContext,
  badRequest,
  loadLockedReport,
  storedFigures,
  usesFigures,
  ymdOrNull,
} from "./shared";

// memberReport.refreshFigures (03-governance.md G12): re-pulls ECONOMICS'
// period data into a DRAFT QUARTERLY / ANNUAL report, keeping the notes, the
// "none" confirmation of Manager payments and an entered utilization.

export const refreshFiguresProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportRefreshFiguresSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();

    return await ctx.db.$transaction(
      async (tx) => {
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "DRAFT") {
          badRequest("Only a draft can be refreshed.");
        }
        if (!usesFigures(report.type)) {
          badRequest(
            "Only quarterly reports and annual statements have figures.",
          );
        }
        const start = ymdOrNull(report.periodStart);
        const end = ymdOrNull(report.periodEnd);
        if (start === null || end === null) {
          badRequest("This report has no period.");
        }
        const period = { start, end };
        const previous =
          storedFigures(report.type, report.figures) ?? undefined;
        const figures = figuresFromPeriodData(
          await loadPeriodReportInput(tx, companyId, period),
          period,
          now.toISOString(),
          previous,
        );

        const updated = await guardedWrite(() =>
          tx.memberReport.update({
            where: { id: report.id, companyId, status: "DRAFT" },
            data: { figures: figures as object },
            select: { id: true },
          }),
        );
        if (!updated) badRequest("Only a draft can be refreshed.");

        await Audit.create(
          {
            action: "memberReport.updated",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary: `${ctx.session.user.name ?? "A user"} refreshed the figures of the draft report "${report.title}" from the ledger`,
          },
          tx,
        );
        return { figures };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  });
