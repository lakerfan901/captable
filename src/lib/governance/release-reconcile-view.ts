// The Reconciliation block of the release dialog (04-investor-portal.md
// P38, 6.3 "Release dialog"; package P16). Pure: relative imports only.
//
// Fed ahead of time by `memberReport.reconcile` and, when a release is
// refused anyway (the ledger changed in between), by
// `error.data.reconciliation`; the refusal is the newer answer and wins
// until the figures are refreshed or re-checked.

import { formatDateOnly } from "../date-only";
import {
  centsText,
  type FigureDifference,
  figureLabel,
} from "./reconcile-refusal";

export interface ReconcileAnswer {
  checked: boolean;
  differences: FigureDifference[];
}

export interface DifferenceRow {
  field: string;
  label: string;
  report: string;
  ledger: string;
}

export type ReconcileBlock =
  /** not a quarterly or annual report, or nothing to compare (no period, figures not readable) */
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "match" }
  | { kind: "differences"; rows: DifferenceRow[] };

export function differenceRows(
  differences: readonly FigureDifference[],
): DifferenceRow[] {
  return differences.map((d) => ({
    field: d.field,
    label: figureLabel(d.field),
    report: centsText(d.reportCents),
    ledger: centsText(d.ledgerCents),
  }));
}

export function reconcileBlock(args: {
  withFigures: boolean;
  answer: ReconcileAnswer | undefined;
  error: string | null;
  fetching: boolean;
  /** the differences of a refused release, newer than `answer` */
  refusal: readonly FigureDifference[] | null;
}): ReconcileBlock {
  if (!args.withFigures) return { kind: "none" };
  if (args.refusal !== null && args.refusal.length > 0) {
    return { kind: "differences", rows: differenceRows(args.refusal) };
  }
  if (args.error !== null) return { kind: "error", message: args.error };
  if (args.answer === undefined || args.fetching) return { kind: "loading" };
  if (!args.answer.checked) return { kind: "none" };
  return args.answer.differences.length === 0
    ? { kind: "match" }
    : { kind: "differences", rows: differenceRows(args.answer.differences) };
}

/**
 * Why the block holds Release back (null: it does not). An error of the
 * check itself does not block: the release repeats the check under its locks
 * and refuses with the list if it must.
 */
export function reconcileBlocks(block: ReconcileBlock): string | null {
  if (block.kind === "loading")
    return "Checking the figures against the ledger…";
  if (block.kind === "differences") {
    return "The report figures differ from the ledger. Refresh them from the ledger or correct the ledger.";
  }
  return null;
}

/** The difference count as a sentence. */
export function differencesSentence(n: number): string {
  return n === 1
    ? "1 figure differs from the ledger for this period."
    : `${n} figures differ from the ledger for this period.`;
}

/** P38 consequence line (quarterly and annual reports only). */
export function dashboardConsequence(
  type: string,
  periodEnd: string | null,
): string | null {
  if ((type !== "QUARTERLY" && type !== "ANNUAL") || periodEnd === null) {
    return null;
  }
  return `The financial dashboard will show figures through ${formatDateOnly(periodEnd)} to the selected holders.`;
}

/**
 * The lines of a released quarterly or annual report page (6.3 "Report
 * page", P35): how far the dashboard is published, and, when a month of the
 * report's period was restated, the note that the report keeps its figures
 * as issued while the dashboard shows the restated ones.
 */
export function reportFinancialsLines(
  view: {
    publishedThrough: string | null;
    restatements: readonly { month: string; at: string }[];
  },
  period: { start: string | null; end: string | null },
): { publishedThrough: string | null; restated: string | null } {
  const publishedThrough = view.publishedThrough
    ? `Financials published through ${formatDateOnly(view.publishedThrough)}`
    : null;
  const { start, end } = period;
  if (start === null || end === null) {
    return { publishedThrough, restated: null };
  }
  const firstMonth = `${start.slice(0, 7)}-01`;
  const dates = [
    ...new Set(
      view.restatements
        .filter((r) => r.month >= firstMonth && r.month <= end)
        .map((r) => r.at),
    ),
  ].sort();
  const restated =
    dates.length === 0
      ? null
      : `Figures for this period were restated on ${dates
          .map(formatDateOnly)
          .join(", ")}; the dashboard shows the restated figures.`;
  return { publishedThrough, restated };
}

/** `error.data.reconciliation.differences` of a refused release, or null. */
export function refusalDifferences(e: unknown): FigureDifference[] | null {
  if (e === null || typeof e !== "object") return null;
  const data = (e as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const rec = (data as { reconciliation?: unknown }).reconciliation;
  if (rec === null || typeof rec !== "object") return null;
  const diffs = (rec as { differences?: unknown }).differences;
  return Array.isArray(diffs) ? (diffs as FigureDifference[]) : null;
}
