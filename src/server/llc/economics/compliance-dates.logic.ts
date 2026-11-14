/**
 * Computed compliance dates (02-economics.md E19 table). Pure, relative
 * imports only. The server gathers the inputs (Available Cash per ended
 * quarter, Call Notice lines, defaults, loans) with the existing services.
 */
import type { LlcEconomicsConfig } from "../../../lib/llc/config";
import {
  addDays,
  compareIso,
  type IsoDate,
  quarterOf,
} from "../../../lib/llc/dates";
import type { Cents } from "../../../lib/llc/money";
import { distributionDeadline, type TermClock } from "../../../lib/llc/term";
import { formatCents } from "../../../lib/money";

export type ComplianceStatus =
  | "OPEN"
  | "OVERDUE"
  | "ACTION_REQUIRED"
  | "DONE"
  | "NOT_REQUIRED"
  | "INFO";

export type ComplianceKind =
  | "DISTRIBUTION_DEADLINE"
  | "QUARTERLY_REPORT_DEADLINE"
  | "CALL_NOTICE_DUE"
  | "BALANCE_OUTSIDE_DATE"
  | "FORFEITURE_DATE"
  | "CREDIT_DATE"
  | "REPLACEMENT_FUNDER_OUTSIDE_DATE"
  | "OCD_NOTICE_DUE"
  | "EXTENSION_REQUEST_DUE"
  | "TARGET_SALE_DATE"
  | "DISSOLUTION_ELECTION_AVAILABLE"
  | "MEMBER_LOAN_MATURITY"
  | "REFUND_DUE"
  | "ACCEPTANCE_DEADLINE"
  | "FINAL_CLOSING_DATE";

export type ComplianceDate = {
  /** stable: `${kind}:${sourceId ?? period}` */
  key: string;
  kind: ComplianceKind;
  dueOn: IsoDate;
  label: string;
  oaSection: string;
  status: ComplianceStatus;
  sourceType: string;
  sourceId: string | null;
};

export interface ComplianceQuarter {
  quarterEnd: IsoDate;
  /** a FINALIZED, unreversed OPERATING or SALE distribution has its period end in that quarter */
  hasDistribution: boolean;
  /** computeAvailableCash(asOf = quarterEnd).availableCash; only read for ended quarters */
  availableCash: Cents;
}

export interface ComplianceInput {
  today: IsoDate;
  range: { from: IsoDate; to: IsoDate };
  config: Pick<
    LlcEconomicsConfig,
    | "distributionDeadlineDays"
    | "balanceOutsideDate"
    | "replacementFunderOutsideDate"
  >;
  clock: TermClock;
  /** appliedOn of the first applied, non-void CapitalReceipt; null = no quarters yet */
  firstReceiptOn: IsoDate | null;
  quarters: readonly ComplianceQuarter[];
  /** SENT Call Notice lines */
  callLines: readonly {
    id: string;
    dueOn: IsoDate | null;
    outstanding: Cents;
    label?: string;
    /** a default (not voided) was declared on the line: its own dates take over */
    defaultDeclared?: boolean;
  }[];
  anyUncalledBalance: boolean;
  defaults: readonly {
    id: string;
    status: "OPEN" | "CURED" | "VOIDED";
    memberName?: string;
    forfeitureDate: IsoDate;
    forfeitureConfirmed: boolean;
    /** computed (or stored once confirmed) Credit Date */
    creditDate: IsoDate;
    creditConfirmed: boolean;
    outstanding: Cents;
  }[];
  loans: readonly {
    id: string;
    maturityOn: IsoDate;
    principalOutstanding: Cents;
    lenderName?: string;
  }[];
  ocdNoticeSentOn: IsoDate | null;
  /** Preferred class Final Closing Date (Section 4.8); null = not set */
  finalClosingDate?: IsoDate | null;
  /** PENDING commitments whose Section 4.8 clock has started */
  pendingDecisions?: readonly {
    id: string;
    /** the earlier of the acceptance deadline and the Final Closing Date */
    decideBy: IsoDate;
    memberName?: string;
  }[];
  /** decided commitments with part of the refund still unpaid */
  refunds?: readonly {
    id: string;
    dueBy: IsoDate;
    outstanding: Cents;
    memberName?: string;
  }[];
}

/** Quarter ends from the quarter of `firstReceiptOn` whose deadline falls in the range. */
export function complianceQuarterEnds(
  firstReceiptOn: IsoDate | null,
  range: { from: IsoDate; to: IsoDate },
  config: Pick<LlcEconomicsConfig, "distributionDeadlineDays">,
): { quarterEnd: IsoDate; deadline: IsoDate; label: string }[] {
  if (firstReceiptOn === null) return [];
  const out: { quarterEnd: IsoDate; deadline: IsoDate; label: string }[] = [];
  let q = quarterOf(firstReceiptOn);
  for (;;) {
    const deadline = distributionDeadline(q.end, config as LlcEconomicsConfig);
    if (compareIso(deadline, range.to) > 0) break;
    if (compareIso(deadline, range.from) >= 0) {
      out.push({
        quarterEnd: q.end,
        deadline,
        label: `Q${q.quarter} ${q.year}`,
      });
    }
    q = quarterOf(addDays(q.end, 1));
  }
  return out;
}

const inRange = (d: IsoDate, r: { from: IsoDate; to: IsoDate }) =>
  compareIso(d, r.from) >= 0 && compareIso(d, r.to) <= 0;

/** OPEN, or OVERDUE once `dueOn < today`. */
function openOrOverdue(dueOn: IsoDate, today: IsoDate): ComplianceStatus {
  return compareIso(dueOn, today) < 0 ? "OVERDUE" : "OPEN";
}

export function buildComplianceDates(i: ComplianceInput): ComplianceDate[] {
  const out: ComplianceDate[] = [];
  const push = (
    d: Omit<ComplianceDate, "key"> & { period?: IsoDate },
  ): void => {
    if (!inRange(d.dueOn, i.range)) return;
    const { period, ...rest } = d;
    out.push({
      key: `${d.kind}:${d.sourceId ?? period ?? d.dueOn}`,
      ...rest,
    });
  };

  // §5.6(a) / §8.2 quarterly deadlines (R42)
  const byEnd = new Map(i.quarters.map((q) => [q.quarterEnd, q]));
  for (const q of complianceQuarterEnds(i.firstReceiptOn, i.range, i.config)) {
    const data = byEnd.get(q.quarterEnd);
    const ended = compareIso(q.quarterEnd, i.today) < 0;
    let status: ComplianceStatus;
    if (!ended) status = "OPEN";
    else if (data?.hasDistribution) status = "DONE";
    else if ((data?.availableCash ?? 0n) <= 0n) status = "NOT_REQUIRED";
    else status = openOrOverdue(q.deadline, i.today);
    push({
      kind: "DISTRIBUTION_DEADLINE",
      dueOn: q.deadline,
      label: `Distribute Available Cash for ${q.label}`,
      oaSection: "§5.6(a)",
      status,
      sourceType: "quarter",
      sourceId: null,
      period: q.quarterEnd,
    });
    push({
      kind: "QUARTERLY_REPORT_DEADLINE",
      dueOn: q.deadline,
      label: `Quarterly report for ${q.label}`,
      oaSection: "§8.2",
      status: "OPEN",
      sourceType: "quarter",
      sourceId: null,
      period: q.quarterEnd,
    });
  }

  // §4.9 Call Notices (R26). Once a default is declared on a line, the
  // default's own dates (Forfeiture Date, Credit Date) take over.
  for (const l of i.callLines) {
    if (l.dueOn === null || l.outstanding <= 0n || l.defaultDeclared) continue;
    push({
      kind: "CALL_NOTICE_DUE",
      dueOn: l.dueOn,
      label: l.label ?? "Call Notice payment due",
      oaSection: "§4.9",
      status: openOrOverdue(l.dueOn, i.today),
      sourceType: "callNoticeLine",
      sourceId: l.id,
    });
  }

  // §4.9 outside date (R27)
  if (i.anyUncalledBalance && i.config.balanceOutsideDate !== null) {
    push({
      kind: "BALANCE_OUTSIDE_DATE",
      dueOn: i.config.balanceOutsideDate,
      label: "Every uncalled Balance is due",
      oaSection: "§4.9",
      status: openOrOverdue(i.config.balanceOutsideDate, i.today),
      sourceType: "unitClass",
      sourceId: null,
    });
  }

  // §4.9(iv) forfeiture and credit (R33, R35)
  let anyDefaultOutstanding = false;
  for (const d of i.defaults) {
    if (d.status === "VOIDED") continue;
    const who = d.memberName ? ` (${d.memberName})` : "";
    if (d.status === "OPEN" && d.outstanding > 0n) anyDefaultOutstanding = true;
    if (d.status === "OPEN" && !d.forfeitureConfirmed) {
      push({
        kind: "FORFEITURE_DATE",
        dueOn: d.forfeitureDate,
        label: `Forfeiture Date${who}`,
        oaSection: "§4.9(iv)",
        // the forfeiture can be confirmed from the day after the Forfeiture Date
        status:
          compareIso(i.today, d.forfeitureDate) > 0
            ? "ACTION_REQUIRED"
            : "OPEN",
        sourceType: "memberDefault",
        sourceId: d.id,
      });
    }
    if (d.forfeitureConfirmed && !d.creditConfirmed) {
      push({
        kind: "CREDIT_DATE",
        dueOn: d.creditDate,
        label: `Credit Date${who}`,
        oaSection: "§4.9(iv)",
        // the credit can be confirmed on the Credit Date
        status:
          compareIso(i.today, d.creditDate) >= 0 ? "ACTION_REQUIRED" : "OPEN",
        sourceType: "memberDefault",
        sourceId: d.id,
      });
    }
  }
  if (anyDefaultOutstanding) {
    push({
      kind: "REPLACEMENT_FUNDER_OUTSIDE_DATE",
      dueOn: i.config.replacementFunderOutsideDate,
      label: "Last day for Replacement Funders",
      oaSection: "§4.8(b)",
      status: openOrOverdue(i.config.replacementFunderOutsideDate, i.today),
      sourceType: "llcTerm",
      sourceId: null,
    });
  }

  // Term clock (R41)
  const c = i.clock;
  if (c.operationsCommencementDate !== null) {
    if (c.ocdNoticeDueOn !== null && i.ocdNoticeSentOn === null) {
      push({
        kind: "OCD_NOTICE_DUE",
        dueOn: c.ocdNoticeDueOn,
        label: "Notify members of the Operations Commencement Date",
        oaSection: "§1.21",
        status: openOrOverdue(c.ocdNoticeDueOn, i.today),
        sourceType: "llcTerm",
        sourceId: null,
      });
    }
    if (c.extensionRequestDueOn !== null) {
      push({
        kind: "EXTENSION_REQUEST_DUE",
        dueOn: c.extensionRequestDueOn,
        label: "Last day to request a term extension",
        oaSection: "§2.5",
        status: openOrOverdue(c.extensionRequestDueOn, i.today),
        sourceType: "llcTerm",
        sourceId: null,
      });
    }
    if (c.effectiveTargetSaleDate !== null) {
      push({
        kind: "TARGET_SALE_DATE",
        dueOn: c.effectiveTargetSaleDate,
        label: "Target Sale Date",
        oaSection: "§2.4",
        status: openOrOverdue(c.effectiveTargetSaleDate, i.today),
        sourceType: "llcTerm",
        sourceId: null,
      });
    }
    if (c.dissolutionElectionAvailableAfter !== null) {
      push({
        kind: "DISSOLUTION_ELECTION_AVAILABLE",
        dueOn: c.dissolutionElectionAvailableAfter,
        label: "Dissolution election becomes available",
        oaSection: "§11.1(d)",
        status: "INFO",
        sourceType: "llcTerm",
        sourceId: null,
      });
    }
  }

  // §4.8 admission: the Final Closing Date, decisions on signed
  // subscriptions, refunds of the unaccepted part. A decision or a refund
  // leaves the feed once it is recorded (the calendar then closes its row).
  const closing = i.finalClosingDate ?? null;
  if (closing !== null) {
    push({
      kind: "FINAL_CLOSING_DATE",
      dueOn: closing,
      label: "Final Closing Date: last day to accept a subscription",
      oaSection: "§4.8",
      // a date, not a task: done once it has passed
      status: compareIso(closing, i.today) < 0 ? "DONE" : "OPEN",
      sourceType: "unitClass",
      sourceId: null,
    });
  }
  for (const p of i.pendingDecisions ?? []) {
    push({
      kind: "ACCEPTANCE_DEADLINE",
      dueOn: p.decideBy,
      label: p.memberName
        ? `Accept or reject the subscription of ${p.memberName}`
        : "Accept or reject the subscription",
      oaSection: "§4.8",
      status: openOrOverdue(p.decideBy, i.today),
      sourceType: "commitment",
      sourceId: p.id,
    });
  }
  for (const r of i.refunds ?? []) {
    if (r.outstanding <= 0n) continue;
    push({
      kind: "REFUND_DUE",
      dueOn: r.dueBy,
      label: r.memberName
        ? `Refund ${formatCents(r.outstanding)} to ${r.memberName}`
        : `Refund ${formatCents(r.outstanding)}`,
      oaSection: "§4.8",
      status: openOrOverdue(r.dueBy, i.today),
      sourceType: "commitment",
      sourceId: r.id,
    });
  }

  // §4.6 member loans (R25)
  for (const l of i.loans) {
    if (l.principalOutstanding <= 0n) continue;
    push({
      kind: "MEMBER_LOAN_MATURITY",
      dueOn: l.maturityOn,
      label: l.lenderName
        ? `Member loan from ${l.lenderName} matures`
        : "Member loan matures",
      oaSection: "§4.6",
      status: openOrOverdue(l.maturityOn, i.today),
      sourceType: "memberLoan",
      sourceId: l.id,
    });
  }

  return out.sort(
    (a, b) => compareIso(a.dueOn, b.dueOn) || (a.key < b.key ? -1 : 1),
  );
}

/** Overview list: the next `n` dates still to act on (overdue first by date), skipping DONE, NOT_REQUIRED and past OPEN report reminders. */
export function nextComplianceDates(
  dates: readonly ComplianceDate[],
  today: IsoDate,
  n: number,
): ComplianceDate[] {
  return dates
    .filter(
      (d) =>
        d.status !== "DONE" &&
        d.status !== "NOT_REQUIRED" &&
        (d.status === "OVERDUE" ||
          d.status === "ACTION_REQUIRED" ||
          compareIso(d.dueOn, today) >= 0),
    )
    .slice(0, n);
}
