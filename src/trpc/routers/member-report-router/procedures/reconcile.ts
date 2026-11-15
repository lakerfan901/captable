import type { FigureDifference } from "@/lib/governance/report-reconcile";
import { reconcileFigures } from "@/lib/governance/report-reconcile";
import { getPeriodEconomics } from "@/server/llc/economics";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportReconcileSchema } from "../schema";
import {
  findReportRef,
  readFrozenContent,
  storedFigures,
  usesFigures,
  ymdOrNull,
} from "./shared";

// memberReport.reconcile (04-investor-portal.md P38, 5.9; package P13a).
// Read only, no lock: what the release check (`release.ts` step 1b) would
// refuse on now. Feeds the Reconciliation block of the release dialog (P16).
//
// - A draft is compared from its stored figures (`source: "DRAFT"`).
// - A released report is compared from its frozen figures
//   (`source: "FROZEN"`): a difference then means the ledger changed after
//   release (the report is never rewritten, P35).
// - Notices and K-1 reports have no figures (`checked: false`, `NO_FIGURES`);
//   a draft whose figures do not parse yet (`FIGURES_INCOMPLETE`) is refused
//   by release on content before P38 is reached.

export type ReconcileSkipReason =
  | "NO_FIGURES"
  | "NO_PERIOD"
  | "FIGURES_INCOMPLETE";

export interface ReconcileResult {
  checked: boolean;
  reason: ReconcileSkipReason | null;
  source: "DRAFT" | "FROZEN" | null;
  period: { start: string; end: string } | null;
  differences: FigureDifference[];
}

export const reconcileProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberReportReconcileSchema)
  .query(async ({ ctx, input }): Promise<ReconcileResult> => {
    const companyId = ctx.membership.companyId;
    const ref = await findReportRef(ctx.db, companyId, input.publicId);
    const report = await ctx.db.memberReport.findFirstOrThrow({
      where: { id: ref.id, companyId },
      select: {
        type: true,
        status: true,
        figures: true,
        frozenContent: true,
        periodStart: true,
        periodEnd: true,
      },
    });
    const skip = (
      reason: ReconcileSkipReason,
      period: ReconcileResult["period"] = null,
    ): ReconcileResult => ({
      checked: false,
      reason,
      source: null,
      period,
      differences: [],
    });
    if (!usesFigures(report.type)) return skip("NO_FIGURES");
    const start = ymdOrNull(report.periodStart);
    const end = ymdOrNull(report.periodEnd);
    if (start === null || end === null) return skip("NO_PERIOD");
    const period = { start, end };

    const draft = report.status === "DRAFT";
    const figures = draft
      ? storedFigures(report.type, report.figures)
      : (readFrozenContent(report.frozenContent)?.figures ?? null);
    if (figures === null) return skip("FIGURES_INCOMPLETE", period);

    const economics = await getPeriodEconomics(ctx.db, companyId, {
      periodStart: start,
      periodEnd: end,
    });
    return {
      checked: true,
      reason: null,
      source: draft ? "DRAFT" : "FROZEN",
      period,
      differences: reconcileFigures(figures, economics),
    };
  });
