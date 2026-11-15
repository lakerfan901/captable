// Pure parts of `memberReport.release` (04-investor-portal.md P17–P22, 5.5;
// package P4a): the refusal message, the deadline keys a report satisfies and
// the audit summary. Relative imports only (tested without the `@/` alias).

import type { AudienceRefusal } from "../portal/audience-core";

/**
 * The refusals of `audienceProblems` as one message, each reason once, with
 * the names of the holders it concerns (ids are never shown; an unknown id
 * has no name).
 */
export function refusalMessage(
  refusals: readonly AudienceRefusal[],
  nameOf: (stakeholderId: string) => string | undefined,
): string {
  const order: string[] = [];
  const names = new Map<string, string[]>();
  for (const r of refusals) {
    if (!names.has(r.message)) {
      names.set(r.message, []);
      order.push(r.message);
    }
    const name =
      r.stakeholderId === undefined ? undefined : nameOf(r.stakeholderId);
    const list = names.get(r.message);
    if (name !== undefined && list !== undefined && !list.includes(name)) {
      list.push(name);
    }
  }
  return order
    .map((message) => {
      const list = names.get(message) ?? [];
      return list.length > 0 ? `${message} (${list.join(", ")})` : message;
    })
    .join(" ");
}

/**
 * The rule deadlines a report satisfies by its own period (03-governance.md
 * G12 send step 5): `QUARTERLY_REPORT:{fy}Q{q}` and `ANNUAL_FINANCIALS:{fy}`.
 * K-1 keys follow the coverage rule and a related deadline is added by the
 * caller.
 */
export function reportDeadlineKeys(report: {
  type: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
}): string[] {
  if (report.type === "QUARTERLY" && report.fiscalYear && report.fiscalQuarter)
    return [`QUARTERLY_REPORT:${report.fiscalYear}Q${report.fiscalQuarter}`];
  if (report.type === "ANNUAL" && report.fiscalYear)
    return [`ANNUAL_FINANCIALS:${report.fiscalYear}`];
  return [];
}

export interface ReleaseSummaryInput {
  userName: string;
  title: string;
  /** Recipient names, in the order stored. */
  recipientNames: readonly string[];
  emailed: boolean;
  /** Books closed through this date (QUARTERLY, ANNUAL), else null. */
  booksClosedThrough: string | null;
  deadlinesDone: readonly string[];
  /** TAX_K1 with email: the year's K-1 deadlines stay open for these holders. */
  k1Missing: readonly string[];
  fiscalYear: number | null;
  /** Open deadlines this report would have closed, left open (P22). */
  deadlinesLeftOpen: readonly string[];
}

/**
 * The `memberReport.released` audit summary (5.5): who, which report, how
 * many and which holders (S5), whether emailed, the books, and which
 * deadlines closed or stayed open.
 */
export function releaseAuditSummary(input: ReleaseSummaryInput): string {
  const n = input.recipientNames.length;
  const parts = [
    `${input.userName} released the report "${input.title}" to ${n} ${n === 1 ? "recipient" : "recipients"} (${input.recipientNames.join(", ")})`,
    input.emailed ? "emailed" : "not emailed (published in the portal only)",
  ];
  if (input.booksClosedThrough !== null) {
    parts.push(`books closed through ${input.booksClosedThrough}`);
  }
  if (input.deadlinesDone.length > 0) {
    parts.push(`deadlines done: ${input.deadlinesDone.join(", ")}`);
  }
  if (input.k1Missing.length > 0) {
    parts.push(
      `FY${input.fiscalYear ?? ""} K-1 deadlines stay open, no K-1 delivered yet to: ${input.k1Missing.join(", ")}`,
    );
  }
  if (input.deadlinesLeftOpen.length > 0) {
    const why = input.emailed
      ? "not every holder of the default audience is selected"
      : "the report is not emailed";
    parts.push(
      `deadlines stay open because ${why}: ${input.deadlinesLeftOpen.join(", ")}`,
    );
  }
  return parts.join("; ");
}
