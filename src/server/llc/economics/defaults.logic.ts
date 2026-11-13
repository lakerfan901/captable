// Pure parts of the default workflow (R30–R38, OA §4.9). Relative imports
// only: tested by vitest, which has no `@/` alias. `defaults.ts` loads rows,
// calls `evaluateDefault` and the planners below, compares the result with
// what the Manager confirmed, and writes through FOUNDATION's services.

import type { LlcEconomicsConfig, OffsetTarget } from "../../../lib/llc/config";
import {
  addDays,
  compareIso,
  type IsoDate,
  maxIso,
} from "../../../lib/llc/dates";
import {
  type BalanceReduction,
  creditDate as computeCreditDate,
  fullyFundedOn as computeFullyFundedOn,
  cureStatus,
  type DefaultStatus,
  defaultInterest,
  isSuspended,
  outstandingBalance,
} from "../../../lib/llc/default";
import {
  type Cents,
  LlcMathError,
  type MicroUnits,
} from "../../../lib/llc/money";
import { applyDefaultOffset } from "../../../lib/llc/waterfall";
import { formatCents } from "../../../lib/money";

type Cfg = LlcEconomicsConfig;

function minBig(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}
function maxBig(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}
function sum<T>(rows: readonly T[], pick: (row: T) => bigint): bigint {
  return rows.reduce((s, r) => s + pick(r), 0n);
}

// ---------------------------------------------------------------------------
// Rows (database rows converted by defaults.ts; arrays are in creation order)

/** A CallNoticeAllocation of the defaulted line. */
export interface DefaultAllocationRow {
  id: string;
  /** negative on a reversal row */
  amount: Cents;
  receivedOn: IsoDate;
  reversesAllocationId: string | null;
}

/** A MemberDefaultFunding (4.9(ii)). */
export interface DefaultFundingRow {
  id: string;
  funderStakeholderId: string;
  funderCommitmentId: string;
  funderIsInsider: boolean;
  amount: Cents;
  fundedOn: IsoDate;
}

/** A MemberDefaultPayment (cash or distribution offset); reversal rows carry negated amounts. */
export interface DefaultPaymentRow {
  id: string;
  paidOn: IsoDate;
  toBalance: Cents;
  toInterest: Cents;
  toCosts: Cents;
}

/** A MemberDefaultCharge (4.9(v)); reversal rows carry negated amounts. */
export interface DefaultChargeRow {
  id: string;
  incurredOn: IsoDate;
  amount: Cents;
}

// ---------------------------------------------------------------------------
// Reductions (R35)

/**
 * The allocations still in force: a reversal row and the row it reverses
 * are both dropped (the library rejects negative reductions). A reversal
 * that does not exactly negate a row of the same line is a data error.
 */
export function netAllocationRows(
  rows: readonly DefaultAllocationRow[],
): DefaultAllocationRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const reversed = new Set<string>();
  for (const r of rows) {
    if (r.reversesAllocationId === null) continue;
    const original = byId.get(r.reversesAllocationId);
    if (!original || original.amount !== -r.amount) {
      throw new LlcMathError(
        "ALLOCATION_REVERSAL_MISMATCH",
        `Allocation ${r.id} does not reverse an allocation of this line`,
      );
    }
    reversed.add(original.id);
  }
  const inForce = rows.filter(
    (r) => r.reversesAllocationId === null && !reversed.has(r.id),
  );
  for (const r of inForce) {
    if (r.amount < 0n) {
      throw new LlcMathError(
        "NEGATIVE",
        `Allocation ${r.id} is negative and reverses nothing`,
      );
    }
  }
  return inForce.filter((r) => r.amount !== 0n);
}

const REDUCTION_KIND_ORDER: Record<BalanceReduction["by"], number> = {
  MEMBER: 0,
  REPLACEMENT_FUNDER: 1,
};

/**
 * R35 order, identical to the library's private sorter: by date; on the same
 * date MEMBER before REPLACEMENT_FUNDER; then input order. The library
 * re-sorts stably with the same key, so this list is the order it uses.
 */
export function orderReductions(
  reductions: readonly BalanceReduction[],
): BalanceReduction[] {
  return reductions
    .map((r, index) => ({ r, index }))
    .sort(
      (a, b) =>
        compareIso(a.r.on, b.r.on) ||
        REDUCTION_KIND_ORDER[a.r.by] - REDUCTION_KIND_ORDER[b.r.by] ||
        a.index - b.index,
    )
    .map(({ r }) => r);
}

/**
 * Member reductions = net allocations received after the due date (classified
 * by date, whatever their source: PAYMENT, OFFSET, or a PREPAID match of an
 * OUTSIDE_DATE line); allocations received on or before it are what was paid
 * by the due date. Replacement Funder reductions = fundings. Returned in R35
 * order (build once, reuse everywhere, including `lastReductionBy`).
 */
export function buildReductions(
  allocations: readonly DefaultAllocationRow[],
  fundings: readonly Pick<DefaultFundingRow, "amount" | "fundedOn">[],
  dueOn: IsoDate,
): { paidByDue: Cents; reductions: BalanceReduction[] } {
  let paidByDue = 0n;
  const raw: BalanceReduction[] = [];
  for (const a of netAllocationRows(allocations)) {
    if (compareIso(a.receivedOn, dueOn) <= 0) paidByDue += a.amount;
    else raw.push({ on: a.receivedOn, amount: a.amount, by: "MEMBER" });
  }
  for (const f of fundings) {
    if (f.amount <= 0n) {
      throw new LlcMathError("NEGATIVE", "A funding must be positive");
    }
    raw.push({ on: f.fundedOn, amount: f.amount, by: "REPLACEMENT_FUNDER" });
  }
  return { paidByDue, reductions: orderReductions(raw) };
}

/** `by` of the last reduction dated on or before `asOf`, in R35 order; null when none. */
export function lastReductionBy(
  orderedReductions: readonly BalanceReduction[],
  asOf: IsoDate,
): BalanceReduction["by"] | null {
  let last: BalanceReduction["by"] | null = null;
  for (const r of orderedReductions) {
    if (compareIso(r.on, asOf) > 0) break;
    if (r.amount > 0n) last = r.by;
  }
  return last;
}

/** Date of the last reduction (R35 order); null when none. */
function lastReductionOn(
  orderedReductions: readonly BalanceReduction[],
): IsoDate | null {
  const last = orderedReductions[orderedReductions.length - 1];
  return last ? last.on : null;
}

// ---------------------------------------------------------------------------
// Evaluation

export interface DefaultEvaluationInput {
  status: DefaultStatus;
  dueOn: IsoDate;
  /** stored at declaration (authoritative even if extra holidays change later) */
  forfeitureDate: IsoDate;
  amountCalled: Cents;
  allocations: readonly DefaultAllocationRow[];
  fundings: readonly DefaultFundingRow[];
  payments: readonly DefaultPaymentRow[];
  charges: readonly DefaultChargeRow[];
  /** stage 2 as stored, null until confirmed */
  forfeiture: {
    forfeitedOn: IsoDate;
    unpaidAtForfeiture: Cents;
    forfeited: Cents;
  } | null;
  /** stage 3 as stored, null until confirmed */
  credit: { creditDate: IsoDate } | null;
  /** stage 4 as stored, null until confirmed */
  cure: {
    curedOn: IsoDate;
    method: "PAID_IN_FULL" | "REPLACEMENT_FUNDED";
  } | null;
  /** availability of the Manager's actions is judged on `today` */
  today: IsoDate;
  /** figures (balance, interest, costs, suspension) are as of `asOf` */
  asOf: IsoDate;
}

export interface DefaultFigures {
  outstanding: Cents;
  interestAccrued: Cents;
  interestPaid: Cents;
  interestOwed: Cents;
  costsCharged: Cents;
  costsPaid: Cents;
  costsOwed: Cents;
  lastReductionBy: BalanceReduction["by"] | null;
}

export interface DefaultEvaluation extends DefaultFigures {
  unpaidAtDue: Cents;
  paidByDue: Cents;
  /** R35 order */
  reductions: BalanceReduction[];
  /** amountCalled − all net allocations − all fundings (the line's outstanding, = getLineStates) */
  lineOutstanding: Cents;
  /** date the line's outstanding reached 0 (the last reduction), null while > 0 */
  lineSettledOn: IsoDate | null;
  replacementFunded: Cents;
  memberPaidAfterDue: Cents;
  fullyFundedOn: IsoDate | null;
  suspended: boolean;
  forfeiture: {
    confirmed: boolean;
    /** the cure test (PAID_IN_FULL) was met on some date on or before the Forfeiture Date */
    paidInFullByForfeitureDate: boolean;
    /** today > Forfeiture Date, not confirmed, not cured by payment on or before it */
    due: boolean;
    /** due and the default is OPEN: `confirmForfeiture` may run */
    available: boolean;
  };
  credit: {
    confirmed: boolean;
    /** stored once confirmed; otherwise computed from the current reductions (may move earlier) */
    creditDate: IsoDate;
    available: boolean;
  };
  cure: {
    confirmed: boolean;
    /** the cure test is met now and nothing blocks confirming it */
    cured: boolean;
    method: "PAID_IN_FULL" | "REPLACEMENT_FUNDED" | null;
    curedOn: IsoDate | null;
    /** the cure test is met but a forfeiture is due and unconfirmed (4.9: a later payment does not reverse a forfeiture) */
    blockedByForfeiture: boolean;
  };
  /** (OPEN only) paying everything owed on `asOf` would still not let the cure be confirmed */
  cureNeedsConfirmation: boolean;
}

function figuresAt(
  base: {
    unpaidAtDue: Cents;
    dueOn: IsoDate;
    reductions: readonly BalanceReduction[];
    payments: readonly DefaultPaymentRow[];
    charges: readonly DefaultChargeRow[];
  },
  d: IsoDate,
  cfg: Pick<Cfg, "defaultInterestBps" | "defaultInterestDayBasis">,
): DefaultFigures {
  const outstanding = outstandingBalance(base.unpaidAtDue, base.reductions, d);
  const interestAccrued = defaultInterest(
    {
      unpaidAtDue: base.unpaidAtDue,
      dueOn: base.dueOn,
      reductions: base.reductions,
      asOf: d,
    },
    cfg,
  );
  const paidBy = base.payments.filter((p) => compareIso(p.paidOn, d) <= 0);
  const interestPaid = sum(paidBy, (p) => p.toInterest);
  const costsPaid = sum(paidBy, (p) => p.toCosts);
  const costsCharged = sum(
    base.charges.filter((c) => compareIso(c.incurredOn, d) <= 0),
    (c) => c.amount,
  );
  return {
    outstanding,
    interestAccrued,
    interestPaid,
    interestOwed: maxBig(0n, interestAccrued - interestPaid),
    costsCharged,
    costsPaid,
    costsOwed: maxBig(0n, costsCharged - costsPaid),
    lastReductionBy: lastReductionBy(base.reductions, d),
  };
}

function paidInFull(f: DefaultFigures): boolean {
  return (
    cureStatus({
      outstandingBalance: f.outstanding,
      interestOwed: f.interestOwed,
      costsOwed: f.costsOwed,
      lastReductionBy: f.lastReductionBy,
      forfeitureConfirmed: false,
      creditConfirmed: false,
      forfeitureDatePassed: false,
    }).method === "PAID_IN_FULL"
  );
}

/**
 * Everything the default page, the procedures and the distribution run need
 * about one default, from its rows. Pure; throws `LlcMathError` on data that
 * cannot be right (a reversal that matches nothing, a line reduced below 0).
 */
export function evaluateDefault(
  i: DefaultEvaluationInput,
  cfg: Pick<
    Cfg,
    "defaultInterestBps" | "defaultInterestDayBasis" | "creditDateMaxDays"
  >,
): DefaultEvaluation {
  const { paidByDue, reductions } = buildReductions(
    i.allocations,
    i.fundings,
    i.dueOn,
  );
  const unpaidAtDue = i.amountCalled - paidByDue;
  const reduced = sum(reductions, (r) => r.amount);
  const lineOutstanding = unpaidAtDue - reduced;
  // Same figure as getLineStates (raw sums, reversal rows included).
  const raw =
    i.amountCalled -
    sum(i.allocations, (a) => a.amount) -
    sum(i.fundings, (f) => f.amount);
  if (raw !== lineOutstanding) {
    throw new LlcMathError(
      "LINE_MISMATCH",
      "The line's allocations and fundings do not reconcile",
    );
  }
  if (lineOutstanding < 0n) {
    throw new LlcMathError(
      "OVER_REDUCED",
      "Payments and fundings exceed the amount unpaid at the due date",
    );
  }
  const base = {
    unpaidAtDue,
    dueOn: i.dueOn,
    reductions,
    payments: i.payments,
    charges: i.charges,
  };
  const now = figuresAt(base, i.asOf, cfg);
  const fullyFundedOn = computeFullyFundedOn(unpaidAtDue, reductions);
  const fd = i.forfeitureDate;

  // Dates on which anything that enters the cure test changed.
  const eventDates = [
    ...new Set([
      ...reductions.map((r) => r.on),
      ...i.payments.map((p) => p.paidOn),
      ...i.charges.map((c) => c.incurredOn),
    ]),
  ].sort(compareIso);

  const paidInFullByForfeitureDate = eventDates.some(
    (d) =>
      compareIso(d, fd) <= 0 &&
      compareIso(d, i.today) <= 0 &&
      paidInFull(figuresAt(base, d, cfg)),
  );
  const forfeitureConfirmed = i.forfeiture !== null;
  const forfeitureDueOn = (d: IsoDate) =>
    !forfeitureConfirmed &&
    compareIso(d, fd) > 0 &&
    !paidInFullByForfeitureDate;
  const forfeitureDue = i.status !== "VOIDED" && forfeitureDueOn(i.today);

  const creditConfirmed = i.credit !== null;
  const creditDate =
    i.credit?.creditDate ??
    computeCreditDate(
      { dueOn: i.dueOn, forfeitureDate: fd, fullyFundedOn },
      cfg,
    );
  const creditAvailable =
    forfeitureConfirmed &&
    !creditConfirmed &&
    i.status !== "VOIDED" &&
    compareIso(i.today, creditDate) >= 0;

  // Cure (R37).
  let cure: DefaultEvaluation["cure"];
  if (i.status === "CURED" && i.cure) {
    cure = {
      confirmed: true,
      cured: true,
      method: i.cure.method,
      curedOn: i.cure.curedOn,
      blockedByForfeiture: false,
    };
  } else if (i.status !== "OPEN") {
    cure = {
      confirmed: false,
      cured: false,
      method: null,
      curedOn: null,
      blockedByForfeiture: false,
    };
  } else {
    const status = cureStatus({
      outstandingBalance: now.outstanding,
      interestOwed: now.interestOwed,
      costsOwed: now.costsOwed,
      lastReductionBy: now.lastReductionBy,
      forfeitureConfirmed,
      creditConfirmed,
      forfeitureDatePassed: compareIso(i.asOf, fd) > 0,
    });
    let curedOn: IsoDate | null = null;
    if (status.method === "REPLACEMENT_FUNDED") {
      // Funded in full and the Forfeited Amount applied on the Credit Date.
      const funded = fullyFundedOn ?? lastReductionOn(reductions);
      if (funded === null || i.credit === null) {
        throw new LlcMathError("CURE_DATE_UNKNOWN", "No funding date");
      }
      curedOn = maxIso(funded, i.credit.creditDate);
    } else if (status.method === "PAID_IN_FULL") {
      // Start of the last run of event dates on which the test holds.
      let runStart: IsoDate | null = null;
      for (const d of eventDates) {
        if (compareIso(d, i.asOf) > 0) break;
        if (paidInFull(figuresAt(base, d, cfg))) runStart ??= d;
        else runStart = null;
      }
      if (runStart === null) {
        throw new LlcMathError(
          "CURE_DATE_UNKNOWN",
          "The cure test holds but no payment satisfied it",
        );
      }
      curedOn = runStart;
    }
    const blockedByForfeiture = status.cured && forfeitureDue;
    cure = {
      confirmed: false,
      cured: status.cured && !blockedByForfeiture,
      method: status.method,
      curedOn,
      blockedByForfeiture,
    };
  }

  // Would paying everything owed on asOf let the cure be confirmed? (E15 DEFAULT_EXCESS_HELD)
  let cureNeedsConfirmation = false;
  if (i.status === "OPEN") {
    const simulated = cureStatus({
      outstandingBalance: 0n,
      interestOwed: 0n,
      costsOwed: 0n,
      lastReductionBy: now.outstanding > 0n ? "MEMBER" : now.lastReductionBy,
      forfeitureConfirmed,
      creditConfirmed,
      forfeitureDatePassed: compareIso(i.asOf, fd) > 0,
    });
    cureNeedsConfirmation = !simulated.cured || forfeitureDueOn(i.asOf);
  }

  return {
    ...now,
    unpaidAtDue,
    paidByDue,
    reductions,
    lineOutstanding,
    lineSettledOn: lineOutstanding === 0n ? lastReductionOn(reductions) : null,
    replacementFunded: sum(i.fundings, (f) => f.amount),
    memberPaidAfterDue: sum(
      reductions.filter((r) => r.by === "MEMBER"),
      (r) => r.amount,
    ),
    fullyFundedOn,
    suspended: isSuspended(
      { status: i.status, dueOn: i.dueOn, curedOn: i.cure?.curedOn ?? null },
      i.asOf,
    ),
    forfeiture: {
      confirmed: forfeitureConfirmed,
      paidInFullByForfeitureDate,
      due: forfeitureDue,
      available: forfeitureDue && i.status === "OPEN",
    },
    credit: {
      confirmed: creditConfirmed,
      creditDate,
      available: creditAvailable,
    },
    cure,
    cureNeedsConfirmation,
  };
}

// ---------------------------------------------------------------------------
// Stage and actions (list and timeline)

export type DefaultStage =
  | "DECLARED"
  | "FORFEITURE_DUE"
  | "IN_SUSPENSE"
  | "CREDIT_DUE"
  | "CREDITED"
  | "CURE_AVAILABLE"
  | "CURED"
  | "VOIDED";

export type DefaultAction =
  | "CONFIRM_FORFEITURE"
  | "CONFIRM_CREDIT"
  | "CONFIRM_CURE";

export function defaultStage(
  status: DefaultStatus,
  forfeitureDate: IsoDate,
  ev: DefaultEvaluation,
): {
  stage: DefaultStage;
  actions: {
    action: DefaultAction;
    availableOn: IsoDate;
    available: boolean;
  }[];
} {
  const actions: {
    action: DefaultAction;
    availableOn: IsoDate;
    available: boolean;
  }[] = [];
  if (status === "VOIDED") return { stage: "VOIDED", actions };
  if (
    status === "OPEN" &&
    !ev.forfeiture.confirmed &&
    !ev.forfeiture.paidInFullByForfeitureDate &&
    !(ev.cure.cured && !ev.forfeiture.due)
  ) {
    actions.push({
      action: "CONFIRM_FORFEITURE",
      availableOn: forfeitureAvailableOn(forfeitureDate),
      available: ev.forfeiture.available,
    });
  }
  if (ev.forfeiture.confirmed && !ev.credit.confirmed) {
    actions.push({
      action: "CONFIRM_CREDIT",
      availableOn: ev.credit.creditDate,
      available: ev.credit.available,
    });
  }
  if (status === "OPEN" && ev.cure.cured && ev.cure.curedOn !== null) {
    actions.push({
      action: "CONFIRM_CURE",
      availableOn: ev.cure.curedOn,
      available: true,
    });
  }
  let stage: DefaultStage;
  if (status === "CURED") stage = "CURED";
  else if (ev.cure.cured) stage = "CURE_AVAILABLE";
  else if (ev.forfeiture.due) stage = "FORFEITURE_DUE";
  else if (!ev.forfeiture.confirmed) stage = "DECLARED";
  else if (!ev.credit.confirmed)
    stage = ev.credit.available ? "CREDIT_DUE" : "IN_SUSPENSE";
  else stage = "CREDITED";
  return { stage, actions };
}

/** The forfeiture action is available the day after the Forfeiture Date. */
export function forfeitureAvailableOn(forfeitureDate: IsoDate): IsoDate {
  return addDays(forfeitureDate, 1);
}

/**
 * E15 PENDING_DEFAULT_STEP: steps that must be confirmed before a
 * distribution paid on `paymentDate` (evaluation as of today).
 */
export function pendingDefaultSteps(
  status: DefaultStatus,
  forfeitureDate: IsoDate,
  ev: DefaultEvaluation,
  paymentDate: IsoDate,
): ("FORFEITURE" | "CREDIT" | "CURE")[] {
  const steps: ("FORFEITURE" | "CREDIT" | "CURE")[] = [];
  if (status === "VOIDED") return steps;
  if (
    status === "OPEN" &&
    !ev.forfeiture.confirmed &&
    compareIso(forfeitureDate, paymentDate) < 0 &&
    !ev.forfeiture.paidInFullByForfeitureDate
  ) {
    steps.push("FORFEITURE");
  }
  if (
    ev.forfeiture.confirmed &&
    !ev.credit.confirmed &&
    compareIso(ev.credit.creditDate, paymentDate) <= 0
  ) {
    steps.push("CREDIT");
  }
  if (status === "OPEN" && (ev.cure.cured || ev.cure.blockedByForfeiture)) {
    steps.push("CURE");
  }
  return steps;
}

/**
 * Payments still in force: a reversal row (`reversesPaymentId`) and the row
 * it reverses are both dropped. Used for date-order and existence checks;
 * sums may include both rows because the amounts negate.
 */
export function livePayments<
  T extends { id: string; reversesPaymentId: string | null },
>(rows: readonly T[]): T[] {
  const reversed = new Set(
    rows
      .map((r) => r.reversesPaymentId)
      .filter((id): id is string => id !== null),
  );
  return rows.filter(
    (r) => r.reversesPaymentId === null && !reversed.has(r.id),
  );
}

export interface OtherDefault {
  id: string;
  stakeholderId: string;
  status: DefaultStatus;
  forfeitureDate: IsoDate;
  /** position in (dueOn, declaredAt, id) order */
  seq: number;
  ev: DefaultEvaluation;
}

/**
 * Steps of OTHER defaults that must be confirmed before a confirmation that
 * reads positions on `readsOn` (confirmForfeiture: the Forfeiture Date;
 * confirmCredit: the due date). A pending step dated on or before that date
 * changes those positions once written (a forfeiture cancels units, a credit
 * adds capital and units), and confirming out of order would freeze wrong
 * figures. A forfeiture reading only its own member's position is blocked by
 * another forfeiture only of the same member (same date: the earlier
 * declared first). The rules cannot form a cycle (each credit is dated after
 * the due date it reads on).
 */
export function blockingDefaultSteps(i: {
  self: { id: string; stakeholderId: string; seq: number };
  step: "FORFEITURE" | "CREDIT";
  readsOn: IsoDate;
  others: readonly OtherDefault[];
}): { id: string; step: "FORFEITURE" | "CREDIT"; on: IsoDate }[] {
  const out: { id: string; step: "FORFEITURE" | "CREDIT"; on: IsoDate }[] = [];
  for (const o of i.others) {
    if (o.id === i.self.id || o.status === "VOIDED") continue;
    const forfeiturePending =
      o.status === "OPEN" &&
      !o.ev.forfeiture.confirmed &&
      !o.ev.forfeiture.paidInFullByForfeitureDate &&
      compareIso(o.forfeitureDate, i.readsOn) <= 0;
    if (forfeiturePending) {
      const relevant =
        i.step === "CREDIT" ||
        (o.stakeholderId === i.self.stakeholderId &&
          (compareIso(o.forfeitureDate, i.readsOn) < 0 || o.seq < i.self.seq));
      if (relevant) {
        out.push({ id: o.id, step: "FORFEITURE", on: o.forfeitureDate });
      }
    }
    if (
      o.ev.forfeiture.confirmed &&
      !o.ev.credit.confirmed &&
      compareIso(o.ev.credit.creditDate, i.readsOn) <= 0
    ) {
      out.push({ id: o.id, step: "CREDIT", on: o.ev.credit.creditDate });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declaration

export function declarationErrors(i: {
  lineStatus: string;
  dueOn: IsoDate | null;
  today: IsoDate;
  hasDefault: boolean;
  outstanding: Cents;
}): string[] {
  const errors: string[] = [];
  if (i.hasDefault) {
    errors.push(
      "A default has already been recorded for this Call Notice line (a voided default cannot be declared again).",
    );
  }
  if (i.lineStatus !== "SENT" || i.dueOn === null) {
    errors.push(
      "Only a sent Call Notice line that is not paid can be declared in default.",
    );
  } else if (compareIso(i.dueOn, i.today) >= 0) {
    errors.push(
      `The Balance called is due ${i.dueOn}; a default can be declared from the next day (Section 4.9).`,
    );
  }
  if (i.outstanding <= 0n) {
    errors.push("Nothing is outstanding on this Call Notice line.");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Replacement Funder funding (R31)

export function fundingErrors(i: {
  status: DefaultStatus;
  today: IsoDate;
  fundedOn: IsoDate;
  window: { opensOn: IsoDate; closesOn: IsoDate };
  amount: Cents;
  /** outstanding Balance as of fundedOn and as of today (after every recorded reduction) */
  outstandingAtFundedOn: Cents;
  outstandingNow: Cents;
  funderIsDefaulter: boolean;
  funderIsInsider: boolean;
  /** isInsider snapshots of this funder's earlier tranches on this default */
  earlierTranchesInsider: readonly boolean[];
  forfeiture: { forfeitedOn: IsoDate } | null;
  credit: { creditDate: IsoDate } | null;
  forfeitureBaseNetOfReplacementFunding: boolean;
  /** dates of recorded payments that paid default interest */
  interestPaymentDates: readonly IsoDate[];
}): string[] {
  const errors: string[] = [];
  if (i.status !== "OPEN") {
    errors.push(
      "Replacement Funders can fund only an open default (Section 4.9(ii)).",
    );
    return errors;
  }
  if (i.funderIsDefaulter) {
    errors.push("The Defaulting Member cannot be its own Replacement Funder.");
  }
  if (compareIso(i.fundedOn, i.window.opensOn) < 0) {
    errors.push(
      `Replacement Funders may fund from ${i.window.opensOn}, the first business day after the due date (Section 4.9(ii)).`,
    );
  }
  if (compareIso(i.fundedOn, i.window.closesOn) > 0) {
    errors.push(
      `Replacement Funder Units may be issued only on or before ${i.window.closesOn} (Section 4.8(b)).`,
    );
  }
  if (compareIso(i.fundedOn, i.today) > 0) {
    errors.push("The funding date cannot be in the future.");
  }
  const limit = minBig(i.outstandingAtFundedOn, i.outstandingNow);
  if (i.amount <= 0n || i.amount > limit) {
    errors.push(
      `The amount funded must be more than zero and not more than the unpaid Balance outstanding (${formatCents(limit)}).`,
    );
  }
  if (i.earlierTranchesInsider.some((flag) => flag !== i.funderIsInsider)) {
    errors.push(
      "This funder's earlier funding of this default was recorded with a different insider status; correct the member record first (Section 4.9(iv) proviso).",
    );
  }
  if (
    i.forfeiture !== null &&
    i.forfeitureBaseNetOfReplacementFunding &&
    compareIso(i.fundedOn, i.forfeiture.forfeitedOn) <= 0
  ) {
    errors.push(
      `The forfeiture was confirmed on the unpaid Balance at ${i.forfeiture.forfeitedOn}; a funding dated on or before it would change that confirmed amount.`,
    );
  }
  if (i.credit !== null && compareIso(i.fundedOn, i.credit.creditDate) <= 0) {
    errors.push(
      `The credit was confirmed as of ${i.credit.creditDate}; a funding dated on or before it would change that confirmed allocation.`,
    );
  }
  const laterInterest = i.interestPaymentDates.filter(
    (d) => compareIso(d, i.fundedOn) > 0,
  );
  if (laterInterest.length > 0) {
    errors.push(
      `Default interest was already collected on ${laterInterest.sort(compareIso).at(-1)} on the Balance as it stood then; a funding dated earlier would change that interest.`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Member payment (R17 order applied to cash, R18)

export interface DefaultPaymentPlan {
  owed: { balance: Cents; interest: Cents; costs: Cents };
  toBalance: Cents;
  toInterest: Cents;
  toCosts: Cents;
  errors: string[];
}

/**
 * Splits a payment by the Defaulting Member across Balance, interest and
 * costs in `order` (`applyDefaultOffset`). `figures` are as of the payment
 * date; the Balance owed is also capped by the line's outstanding today
 * (fundings dated after the payment date already reduced it).
 */
export function planDefaultPayment(i: {
  status: DefaultStatus;
  dueOn: IsoDate;
  paidOn: IsoDate;
  today: IsoDate;
  amount: Cents;
  figures: Pick<DefaultFigures, "outstanding" | "interestOwed" | "costsOwed">;
  lineOutstandingNow: Cents;
  latestPaymentOn: IsoDate | null;
  forfeiture: { forfeitedOn: IsoDate } | null;
  credit: { creditDate: IsoDate } | null;
  order: readonly OffsetTarget[];
}): DefaultPaymentPlan {
  const errors: string[] = [];
  const suspended = i.status === "OPEN";
  const owed = {
    balance: suspended
      ? maxBig(0n, minBig(i.figures.outstanding, i.lineOutstandingNow))
      : 0n,
    interest: i.figures.interestOwed,
    costs: i.figures.costsOwed,
  };
  if (i.status === "VOIDED") errors.push("This default was voided.");
  if (compareIso(i.paidOn, i.today) > 0) {
    errors.push("The payment date cannot be in the future.");
  }
  if (compareIso(i.paidOn, i.dueOn) <= 0) {
    errors.push(
      `A payment received on or before the due date ${i.dueOn} means the member was not in default: void this default and record the payment on the Call Notice.`,
    );
  }
  if (
    i.latestPaymentOn !== null &&
    compareIso(i.paidOn, i.latestPaymentOn) < 0
  ) {
    errors.push(
      `A payment dated ${i.latestPaymentOn} is already recorded; payments must be recorded in date order.`,
    );
  }
  if (
    i.forfeiture !== null &&
    compareIso(i.paidOn, i.forfeiture.forfeitedOn) <= 0
  ) {
    errors.push(
      `The forfeiture was confirmed on the Balance unpaid at ${i.forfeiture.forfeitedOn}; a payment dated on or before it cannot be recorded now (Section 4.9(iv)).`,
    );
  }
  if (i.credit !== null && compareIso(i.paidOn, i.credit.creditDate) <= 0) {
    errors.push(
      `The credit was confirmed as of ${i.credit.creditDate}; a payment dated on or before it cannot be recorded now.`,
    );
  }
  const split = applyDefaultOffset(
    i.amount,
    {
      memberDefaultId: "",
      dueOn: i.dueOn,
      suspended,
      ...owed,
      cureNeedsConfirmation: false,
    },
    i.order,
  );
  if (split.remaining > 0n) {
    errors.push(
      `The payment exceeds what is owed on ${i.paidOn}: Balance ${formatCents(owed.balance)}, interest ${formatCents(owed.interest)}, costs ${formatCents(owed.costs)}.`,
    );
  }
  return {
    owed,
    toBalance: split.toBalance,
    toInterest: split.toInterest,
    toCosts: split.toCosts,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Credit receipts: which commitment each credit is recorded on (R36)

export interface ActiveCommitment {
  id: string;
  /** ACCEPTED or REDUCED Preferred commitments only */
  acceptedOn: IsoDate | null;
}

export interface CreditTarget {
  holderId: string;
  clause: "A" | "B";
  amount: Cents;
  units: MicroUnits;
  commitmentId: string;
  /** explains a non-obvious choice (several tranches on different commitments) */
  note: string | null;
}

/**
 * Clause A: on the holder's Replacement commitment; a funder with several
 * tranches on different commitments has its whole clause-A credit recorded
 * on the commitment of its EARLIEST funding (by fundedOn, then creation
 * order). Clause B: on the holder's oldest ACCEPTED/REDUCED Preferred
 * commitment (acceptedOn, then creation order). Holders without a usable
 * commitment are returned in `missing` (nothing may be written then).
 */
export function planCreditTargets(i: {
  credits: readonly {
    holderId: string;
    clause: "A" | "B";
    amount: Cents;
    units: MicroUnits;
  }[];
  /** the fundings counted for the credit, in creation order */
  fundings: readonly Pick<
    DefaultFundingRow,
    "funderStakeholderId" | "funderCommitmentId" | "fundedOn"
  >[];
  /** each holder's ACCEPTED/REDUCED Preferred commitments, in creation order */
  activeCommitments: ReadonlyMap<string, readonly ActiveCommitment[]>;
}): {
  targets: CreditTarget[];
  missing: { holderId: string; clause: "A" | "B" }[];
} {
  const targets: CreditTarget[] = [];
  const missing: { holderId: string; clause: "A" | "B" }[] = [];
  for (const c of i.credits) {
    const active = i.activeCommitments.get(c.holderId) ?? [];
    if (c.clause === "A") {
      const tranches = i.fundings
        .map((f, index) => ({ f, index }))
        .filter(({ f }) => f.funderStakeholderId === c.holderId)
        .sort(
          (a, b) => compareIso(a.f.fundedOn, b.f.fundedOn) || a.index - b.index,
        );
      const earliest = tranches[0]?.f;
      if (
        !earliest ||
        !active.some((a) => a.id === earliest.funderCommitmentId)
      ) {
        missing.push({ holderId: c.holderId, clause: "A" });
        continue;
      }
      const commitments = new Set(tranches.map((t) => t.f.funderCommitmentId));
      targets.push({
        ...c,
        commitmentId: earliest.funderCommitmentId,
        note:
          commitments.size > 1
            ? `funded in ${tranches.length} tranches on ${commitments.size} commitments; the whole clause (A) credit is recorded on the commitment of the earliest funding (${earliest.fundedOn})`
            : null,
      });
    } else {
      const oldest = active
        .map((a, index) => ({ a, index }))
        .sort(
          (x, y) =>
            compareIso(
              x.a.acceptedOn ?? "9999-12-31",
              y.a.acceptedOn ?? "9999-12-31",
            ) || x.index - y.index,
        )[0]?.a;
      if (!oldest) {
        missing.push({ holderId: c.holderId, clause: "B" });
        continue;
      }
      targets.push({ ...c, commitmentId: oldest.id, note: null });
    }
  }
  return { targets, missing };
}
