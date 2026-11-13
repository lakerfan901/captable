/**
 * Pure parts of the distribution run (02-economics.md E15): the computation
 * of a draft (positions → waterfall → netting → blockers), the canonical
 * string that is hashed, the rows that finalize and reverse write, and the
 * invariants checked before anything is written. Relative imports only; no
 * Prisma, no `@/`.
 */
import {
  type AvailableCashResult,
  type CashLedger,
  computeAvailableCash,
  computeUnusedCapital,
  reserveBalances,
} from "../../../lib/llc/available-cash";
import type { LlcEconomicsConfig } from "../../../lib/llc/config";
import {
  addDays,
  addMonths,
  compareIso,
  type IsoDate,
  quarterOf,
} from "../../../lib/llc/dates";
import {
  type Cents,
  centsToDecimalString,
  LlcMathError,
  type MicroUnits,
  microUnitsToDecimalString,
} from "../../../lib/llc/money";
import type { PositionsResult } from "../../../lib/llc/positions";
import { distributionDeadline } from "../../../lib/llc/term";
import { microUnitsForAmount } from "../../../lib/llc/units";
import {
  type DefaultOwed,
  liquidationWaterfall,
  netDistributionLine,
  type OffsetApplication,
  runWaterfall,
  type WaterfallHolder,
  type WaterfallResult,
} from "../../../lib/llc/waterfall";
import { firstOfMonth, lastOfMonth } from "./financials.logic";

// ---------------------------------------------------------------------------
// Shapes

export type DistributionType =
  | "OPERATING"
  | "RETURN_OF_UNUSED_CAPITAL"
  | "SALE_OR_LIQUIDATION";

export type ManagerCreditorCategory =
  | "MANAGEMENT_FEE"
  | "EXPENSE_REIMBURSEMENT";

export interface LiquidationCreditorInput {
  payee: string;
  amountCents: number;
  memo: string;
  managerCategory: ManagerCreditorCategory | null;
}

export interface LiquidationInputs {
  cashAvailableCents: number;
  windDownReserveCents: number;
  creditors: LiquidationCreditorInput[];
  isFinal: boolean;
}

/** Draft inputs (wizard state), stored as received in `Distribution.inputs` (cents as JSON numbers). */
export type DistributionInputs =
  | { type: "OPERATING" }
  | { type: "RETURN_OF_UNUSED_CAPITAL"; amountCents: number }
  | { type: "SALE_OR_LIQUIDATION"; liquidation: null }
  | { type: "SALE_OR_LIQUIDATION"; liquidation: LiquidationInputs };

export interface ComputedLine {
  stakeholderId: string;
  name: string;
  isInsider: boolean;
  preferredUnits: MicroUnits;
  commonUnits: MicroUnits;
  /** Accrued and unpaid Preferred Return on the payment date, before this distribution. */
  unpaidReturnBefore: Cents;
  /** Tier (c) weight: unpaid Preferred Return measured as of `returnMeasuredAsOf` (R7). Equals `unpaidReturnBefore` under PAYMENT_DATE. */
  unpaidReturnMeasured: Cents;
  unreturnedBefore: Cents;
  tierC: Cents;
  tierD: Cents;
  tierEPreferred: Cents;
  tierECommon: Cents;
  gross: Cents;
  /** Only applications with a non-zero amount. */
  offsets: OffsetApplication[];
  defaultOffsetBalance: Cents;
  defaultOffsetInterest: Cents;
  defaultOffsetCosts: Cents;
  taxAdvanceOffset: Cents;
  net: Cents;
  /** = unpaidReturnBefore − tierC */
  unpaidReturnAfter: Cents;
  /** = unreturnedBefore − tierD (the Balance offset receipt is added after the distribution, R17) */
  unreturnedAfter: Cents;
}

/** A §4.9(iii) Balance offset that finalize records as a FOUNDATION cash receipt on the payment date. */
export interface PlannedOffsetReceipt {
  stakeholderId: string;
  memberDefaultId: string;
  commitmentId: string;
  callNoticeLineId: string;
  dueOn: IsoDate;
  amount: Cents;
  units: MicroUnits;
}

export interface LiquidationComputation {
  cash: Cents;
  creditors: Cents;
  memberLoans: Cents;
  windDownReserve: Cents;
  /** cash − creditors − memberLoans − windDownReserve; negative only when blocked (INSUFFICIENT_FOR_CREDITORS) */
  netToMembers: Cents;
  creditorRows: {
    payee: string;
    amount: Cents;
    memo: string;
    managerCategory: ManagerCreditorCategory | null;
  }[];
  /** §11.4(b): each loan paid in full (principal + interest accrued and not yet paid) */
  loanPayments: {
    loanId: string;
    lenderStakeholderId: string;
    principal: Cents;
    interest: Cents;
  }[];
}

export interface Issue {
  code: string;
  message: string;
}

export interface DistributionComputation {
  type: DistributionType;
  isLiquidation: boolean;
  periodEnd: IsoDate;
  paymentDate: IsoDate;
  /** paymentDate under PAYMENT_DATE, periodEnd under PERIOD_END (R7) */
  returnMeasuredAsOf: IsoDate;
  availableCash: AvailableCashResult | null;
  unusedCapital: Cents | null;
  liquidation: LiquidationComputation | null;
  amount: Cents;
  tierC: Cents;
  tierD: Cents;
  tierEPreferred: Cents;
  tierECommon: Cents;
  totalDefaultOffset: Cents;
  totalTaxOffset: Cents;
  totalNet: Cents;
  reserveBalance: Cents;
  lines: ComputedLine[];
  offsetReceipts: PlannedOffsetReceipt[];
  blockers: Issue[];
  warnings: Issue[];
  hash: string;
}

/** What finalize needs about each default an offset may be applied to (E11 rules for a payment). */
export interface DefaultRecordInfo {
  memberDefaultId: string;
  stakeholderId: string;
  commitmentId: string;
  callNoticeLineId: string;
  dueOn: IsoDate;
  /** latest paidOn of the payments still in force (E11 `livePayments`) */
  latestLivePaymentOn: IsoDate | null;
  forfeitedOn: IsoDate | null;
  creditDate: IsoDate | null;
}

export interface LoanStateInput {
  loanId: string;
  lenderStakeholderId: string;
  principalOutstanding: Cents;
  /** cumulative interest accrued since the loan was made */
  accruedInterest: Cents;
  interestPaid: Cents;
  maturityOn: IsoDate;
}

export interface BuildComputationInput {
  inputs: DistributionInputs;
  periodEnd: IsoDate;
  paymentDate: IsoDate;
  today: IsoDate;
  config: LlcEconomicsConfig;
  positionsAtPayment: PositionsResult;
  /** same object as positionsAtPayment when prefAccrualCutoff = PAYMENT_DATE */
  positionsAtCutoff: PositionsResult;
  commonUnits: ReadonlyMap<string, MicroUnits>;
  holderMeta: ReadonlyMap<string, { name: string; isInsider: boolean }>;
  cashLedger: CashLedger;
  /** as of paymentDate */
  defaultsOwed: ReadonlyMap<string, readonly DefaultOwed[]>;
  defaultRecords: ReadonlyMap<string, DefaultRecordInfo>;
  taxAdvances: ReadonlyMap<string, Cents>;
  /** as of paymentDate */
  loanStates: readonly LoanStateInput[];
  /** E11 getPendingDefaultSteps messages */
  pendingDefaultSteps: readonly string[];
  overdueUndeclared: number;
  lastLedgerEventOn: IsoDate | null;
  booksClosedThrough: IsoDate | null;
  revenueMonthsSaved: readonly IsoDate[];
  /** month of the OCD, or the earliest saved month when no OCD; null when neither */
  requiredFromMonth: IsoDate | null;
  /** R42 deadline of the quarter of periodEnd; null for a return of unused capital */
  deadline: IsoDate | null;
  operationsCommencementDate: IsoDate | null;
}

// ---------------------------------------------------------------------------
// Helpers

const ZERO = 0n;

function minBig(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 1234567n → "$12,345.67" (messages only). */
export function dollars(c: Cents): string {
  const s = centsToDecimalString(c < 0n ? -c : c);
  const [int = "0", frac = "00"] = s.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${c < 0n ? "-" : ""}$${grouped}.${frac}`;
}

function centsFromInput(n: number, label: string): Cents {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new LlcMathError(
      "BAD_INPUT",
      `${label} must be a non-negative whole number of cents`,
    );
  }
  return BigInt(n);
}

/** Error codes of the library that mean "this run cannot be finalized" rather than "the code is wrong". */
const BLOCKING_MATH_CODES = new Set([
  "EXCEEDS_UNRETURNED_CAPITAL",
  "NO_UNITS_IN_CLASS",
  "INSUFFICIENT_FOR_CREDITORS",
]);

const BLOCKING_MATH_MESSAGES: Record<string, string> = {
  EXCEEDS_UNRETURNED_CAPITAL:
    "The amount exceeds the total Unreturned Capital Contributions; a return of unused capital is a Section 5.6(d) distribution only (Section 1.15).",
  NO_UNITS_IN_CLASS:
    "The residual split pays a class with no outstanding units (Section 5.6(e)); issue the Common Units first.",
  INSUFFICIENT_FOR_CREDITORS:
    "The cash does not cover creditors, member loans and the wind-down reserve (Section 11.4(a), (b)).",
};

function isRealMonthEnd(d: IsoDate): boolean {
  return lastOfMonth(d) === d;
}

// ---------------------------------------------------------------------------
// Computation

export function buildComputation(
  i: BuildComputationInput,
): Omit<DistributionComputation, "hash"> {
  const { inputs, config, periodEnd, paymentDate, today } = i;
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];
  const block = (code: string, message: string) =>
    blockers.push({ code, message });
  const warn = (code: string, message: string) =>
    warnings.push({ code, message });

  const type = inputs.type;
  const isLiquidation =
    inputs.type === "SALE_OR_LIQUIDATION" && inputs.liquidation !== null;
  const usesAvailableCash =
    type === "OPERATING" || (!isLiquidation && type === "SALE_OR_LIQUIDATION");
  const isOperatingOrSale = type !== "RETURN_OF_UNUSED_CAPITAL";
  const returnMeasuredAsOf =
    config.prefAccrualCutoff === "PERIOD_END" ? periodEnd : paymentDate;

  // 1. Holders (R11, R19): everyone with Preferred or Common Units.
  const ids = new Set<string>([
    ...i.positionsAtPayment.holders.keys(),
    ...i.commonUnits.keys(),
  ]);
  const holders: WaterfallHolder[] = [];
  const before = new Map<
    string,
    { unpaidAtPayment: Cents; measured: Cents; unreturned: Cents }
  >();
  for (const id of [...ids].sort(compareText)) {
    const p = i.positionsAtPayment.holders.get(id);
    const preferredUnits = p?.preferredUnits ?? ZERO;
    const commonUnits = i.commonUnits.get(id) ?? ZERO;
    const unpaidAtPayment = p?.unpaidReturn ?? ZERO;
    const unreturned = p?.unreturned ?? ZERO;
    const measured =
      config.prefAccrualCutoff === "PERIOD_END"
        ? (i.positionsAtCutoff.holders.get(id)?.unpaidReturn ?? ZERO)
        : unpaidAtPayment;
    if (preferredUnits === ZERO && commonUnits === ZERO) {
      // Under PERIOD_END a holder may have had units at the period end and
      // none on the payment date (transfer): only what is owed on the
      // payment date counts here.
      if (unpaidAtPayment !== ZERO || unreturned !== ZERO) {
        block(
          "HOLDER_WITHOUT_UNITS",
          `${i.holderMeta.get(id)?.name ?? id} holds no units but is owed Preferred Return or Unreturned Capital Contributions; correct the ledger before distributing.`,
        );
      }
      continue;
    }
    holders.push({
      holderId: id,
      unpaidReturn: measured,
      unreturned,
      preferredUnits,
      commonUnits,
    });
    before.set(id, { unpaidAtPayment, measured, unreturned });
  }

  // 2. Amount (R13, R20, R40).
  let availableCash: AvailableCashResult | null = null;
  let unusedCapital: Cents | null = null;
  let liquidation: LiquidationComputation | null = null;
  let amount = ZERO;
  let waterfall: WaterfallResult | null = null;
  const zeroWaterfall = () =>
    runWaterfall(ZERO, holders, {
      mode: "FULL",
      residualPreferredBps: config.residualPreferredBps,
    });
  const blockOnMath = (e: unknown) => {
    if (e instanceof LlcMathError && BLOCKING_MATH_CODES.has(e.code)) {
      block(e.code, BLOCKING_MATH_MESSAGES[e.code] ?? e.message);
      return;
    }
    throw e;
  };

  if (usesAvailableCash) {
    availableCash = computeAvailableCash(i.cashLedger, periodEnd);
    amount = availableCash.availableCash;
    try {
      waterfall = runWaterfall(amount, holders, {
        mode: "FULL",
        residualPreferredBps: config.residualPreferredBps,
      });
    } catch (e) {
      blockOnMath(e);
    }
  } else if (inputs.type === "RETURN_OF_UNUSED_CAPITAL") {
    amount = centsFromInput(inputs.amountCents, "The amount");
    unusedCapital = minBig(
      computeUnusedCapital(i.cashLedger, paymentDate).unusedCapital,
      computeUnusedCapital(i.cashLedger, today).unusedCapital,
    );
    try {
      waterfall = runWaterfall(amount, holders, {
        mode: "D_ONLY",
        residualPreferredBps: config.residualPreferredBps,
      });
    } catch (e) {
      blockOnMath(e);
    }
  } else if (
    inputs.type === "SALE_OR_LIQUIDATION" &&
    inputs.liquidation !== null
  ) {
    const liq = inputs.liquidation;
    const creditorRows = liq.creditors.map((c, n) => ({
      payee: c.payee,
      amount: centsFromInput(c.amountCents, `Creditor ${n + 1}`),
      memo: c.memo,
      managerCategory: c.managerCategory,
    }));
    const loanPayments = [...i.loanStates]
      .sort((a, b) => compareText(a.loanId, b.loanId))
      .map((l) => ({
        loanId: l.loanId,
        lenderStakeholderId: l.lenderStakeholderId,
        principal: maxBig(ZERO, l.principalOutstanding),
        interest: maxBig(ZERO, l.accruedInterest - l.interestPaid),
      }))
      .filter((l) => l.principal > ZERO || l.interest > ZERO);
    const cash = centsFromInput(liq.cashAvailableCents, "Cash available");
    const windDownReserve = centsFromInput(
      liq.windDownReserveCents,
      "The wind-down reserve",
    );
    const creditors = creditorRows.reduce((s, c) => s + c.amount, ZERO);
    const memberLoans = loanPayments.reduce(
      (s, l) => s + l.principal + l.interest,
      ZERO,
    );
    const netToMembers = cash - creditors - memberLoans - windDownReserve;
    liquidation = {
      cash,
      creditors,
      memberLoans,
      windDownReserve,
      netToMembers,
      creditorRows,
      loanPayments,
    };
    amount = maxBig(ZERO, netToMembers);
    try {
      waterfall = liquidationWaterfall({
        cash,
        creditors,
        memberLoans,
        windDownReserve,
        holders,
        residualPreferredBps: config.residualPreferredBps,
      }).waterfall;
    } catch (e) {
      blockOnMath(e);
    }
  }
  const wf = waterfall ?? zeroWaterfall();

  // 3. Netting per line (R16–R18).
  const lines: ComputedLine[] = [];
  const offsetReceipts: PlannedOffsetReceipt[] = [];
  for (const w of wf.lines) {
    const b = before.get(w.holderId);
    if (!b) throw new Error(`Waterfall line for unknown holder ${w.holderId}`);
    const name = i.holderMeta.get(w.holderId)?.name ?? w.holderId;
    const net = netDistributionLine({
      gross: w.gross,
      defaults: i.defaultsOwed.get(w.holderId) ?? [],
      taxAdvanceOutstanding: maxBig(
        ZERO,
        i.taxAdvances.get(w.holderId) ?? ZERO,
      ),
      order: config.defaultOffsetOrder,
    });
    if (net.excessHeld) {
      block(
        "DEFAULT_EXCESS_HELD",
        `${name}'s default would be paid in full by this distribution, but its cure still needs a forfeiture or credit confirmation; the excess may be paid only when the default is cured (Section 4.9(iii)). Confirm the pending step, or wait for the Credit Date, then recompute.`,
      );
    }
    const offsets = net.offsets.filter(
      (o) => o.toBalance > ZERO || o.toInterest > ZERO || o.toCosts > ZERO,
    );
    for (const o of offsets) {
      const rec = i.defaultRecords.get(o.memberDefaultId);
      if (!rec || rec.stakeholderId !== w.holderId) {
        throw new Error(
          `Offset against default ${o.memberDefaultId} without a matching default record`,
        );
      }
      const problems: string[] = [];
      if (compareIso(paymentDate, rec.dueOn) <= 0) {
        problems.push(
          `the payment date is not after the due date ${rec.dueOn}`,
        );
      }
      if (
        rec.latestLivePaymentOn !== null &&
        compareIso(paymentDate, rec.latestLivePaymentOn) < 0
      ) {
        problems.push(
          `a payment dated ${rec.latestLivePaymentOn} is already recorded on it (payments are recorded in date order)`,
        );
      }
      if (
        rec.forfeitedOn !== null &&
        compareIso(paymentDate, rec.forfeitedOn) <= 0
      ) {
        problems.push(
          `its forfeiture was confirmed as of ${rec.forfeitedOn} (Section 4.9(iv))`,
        );
      }
      if (
        rec.creditDate !== null &&
        compareIso(paymentDate, rec.creditDate) <= 0
      ) {
        problems.push(`its credit was confirmed as of ${rec.creditDate}`);
      }
      if (problems.length > 0) {
        block(
          "OFFSET_DATE_ORDER",
          `The offset of ${name}'s distribution against the default due ${rec.dueOn} cannot be dated ${paymentDate}: ${problems.join("; ")}.`,
        );
      }
      if (o.toBalance > ZERO) {
        offsetReceipts.push({
          stakeholderId: w.holderId,
          memberDefaultId: o.memberDefaultId,
          commitmentId: rec.commitmentId,
          callNoticeLineId: rec.callNoticeLineId,
          dueOn: rec.dueOn,
          amount: o.toBalance,
          units: microUnitsForAmount(
            o.toBalance,
            config.pricePerUnitCents,
            config.fractionalUnitsAllowed,
          ),
        });
        if (compareIso(paymentDate, today) > 0) {
          block(
            "OFFSET_RECEIPT_IN_FUTURE",
            `${dollars(o.toBalance)} of ${name}'s distribution is applied to the unpaid Balance and is recorded as a Capital Contribution received on the payment date ${paymentDate} (Section 4.9(iii)); a receipt cannot be dated in the future. Finalize on or after the payment date.`,
          );
        }
      }
    }
    if (w.tierC > b.unpaidAtPayment) {
      block(
        "RETURN_EXCEEDS_UNPAID",
        `${name}'s Preferred Return measured on ${returnMeasuredAsOf} (${dollars(w.tierC)} paid) exceeds what is accrued and unpaid on the payment date (${dollars(b.unpaidAtPayment)}); an earlier distribution already paid part of it (Section 5.6(c)).`,
      );
    }
    const meta = i.holderMeta.get(w.holderId);
    const holder = holders.find((h) => h.holderId === w.holderId);
    lines.push({
      stakeholderId: w.holderId,
      name,
      isInsider: meta?.isInsider ?? false,
      preferredUnits: holder?.preferredUnits ?? ZERO,
      commonUnits: holder?.commonUnits ?? ZERO,
      unpaidReturnBefore: b.unpaidAtPayment,
      unpaidReturnMeasured: b.measured,
      unreturnedBefore: b.unreturned,
      tierC: w.tierC,
      tierD: w.tierD,
      tierEPreferred: w.tierEPreferred,
      tierECommon: w.tierECommon,
      gross: w.gross,
      offsets,
      defaultOffsetBalance: net.defaultOffsetBalance,
      defaultOffsetInterest: net.defaultOffsetInterest,
      defaultOffsetCosts: net.defaultOffsetCosts,
      taxAdvanceOffset: net.taxAdvanceOffset,
      net: net.net,
      unpaidReturnAfter: b.unpaidAtPayment - w.tierC,
      unreturnedAfter: b.unreturned - w.tierD,
    });
  }

  // 4. Blockers (finalize refuses while any exists).
  if (config.balanceOutsideDate === null) {
    block(
      "TERMS_INCOMPLETE",
      "Enter the Balance outside date (Section 4.9) on the Preferred unit class first.",
    );
  }
  if (amount === ZERO) {
    block("AMOUNT_ZERO", "There is nothing to distribute.");
  }
  if (usesAvailableCash && !isRealMonthEnd(periodEnd)) {
    block(
      "PERIOD_END_NOT_MONTH_END",
      "Available Cash is measured at a month end; choose the last day of a month as the period end.",
    );
  }
  if (compareIso(paymentDate, periodEnd) < 0) {
    block(
      "PAYMENT_BEFORE_PERIOD_END",
      `The payment date ${paymentDate} is before the period end ${periodEnd}.`,
    );
  }
  if (
    i.lastLedgerEventOn !== null &&
    compareIso(paymentDate, i.lastLedgerEventOn) < 0
  ) {
    block(
      "PAYMENT_BEFORE_LEDGER_EVENT",
      `The payment date ${paymentDate} is before the latest ledger entry (${i.lastLedgerEventOn}); distributions are recorded in date order.`,
    );
  }
  const latestPayment = addDays(today, 14);
  if (compareIso(paymentDate, latestPayment) > 0) {
    block(
      "PAYMENT_TOO_FAR_AHEAD",
      `The payment date may be at most 14 days ahead (${latestPayment}).`,
    );
  }
  if (
    isOperatingOrSale &&
    i.booksClosedThrough !== null &&
    compareIso(periodEnd, i.booksClosedThrough) < 0
  ) {
    block(
      "PERIOD_CLOSED",
      `Books are closed through ${i.booksClosedThrough}; the period ending ${periodEnd} is closed. Reopen the books on the Term clock settings page first.`,
    );
  }
  if (isOperatingOrSale && i.requiredFromMonth !== null) {
    const saved = new Set(i.revenueMonthsSaved.map(firstOfMonth));
    const missing: IsoDate[] = [];
    const last = firstOfMonth(periodEnd);
    for (
      let m = firstOfMonth(i.requiredFromMonth);
      compareIso(m, last) <= 0;
      m = addMonths(m, 1)
    ) {
      if (!saved.has(m)) missing.push(m.slice(0, 7));
    }
    if (missing.length > 0) {
      block(
        "MISSING_REVENUE_MONTH",
        `Save the revenue for ${missing.join(", ")} first (enter zero for a month without revenue).`,
      );
    }
  }
  const reserves = reserveBalances(i.cashLedger.reserves, periodEnd);
  if (usesAvailableCash) {
    const minimum = reserves.byKind.get("MINIMUM_OPERATING")?.total ?? ZERO;
    if (minimum < config.minimumOperatingReserveCents) {
      block(
        "MIN_RESERVE",
        `The minimum operating reserve is ${dollars(minimum)} on ${periodEnd}; Section 5.6(a) requires ${dollars(config.minimumOperatingReserveCents)}.`,
      );
    }
  }
  if (!isLiquidation) {
    for (const l of i.loanStates) {
      if (
        compareIso(l.maturityOn, paymentDate) <= 0 &&
        l.principalOutstanding > ZERO
      ) {
        block(
          "LOAN_PAST_MATURITY",
          `A member loan matured on ${l.maturityOn} with ${dollars(l.principalOutstanding)} of principal outstanding; it must be repaid before distributions (Section 4.6).`,
        );
      }
    }
  }
  for (const message of i.pendingDefaultSteps) {
    block("PENDING_DEFAULT_STEP", message);
  }
  if (
    type === "RETURN_OF_UNUSED_CAPITAL" &&
    unusedCapital !== null &&
    amount > unusedCapital
  ) {
    block(
      "EXCEEDS_UNUSED_CAPITAL",
      `Only ${dollars(maxBig(ZERO, unusedCapital))} of unused capital is available (Section 1.15).`,
    );
  }

  // 5. Warnings.
  if (i.overdueUndeclared > 0) {
    warn(
      "OVERDUE_UNDECLARED",
      `${i.overdueUndeclared} overdue Call Notice line(s) have no declared default; those members are paid normally.`,
    );
  }
  if (i.deadline !== null && compareIso(paymentDate, i.deadline) > 0) {
    warn(
      "DEADLINE_PASSED",
      `The payment date is after the Section 5.6(a) deadline of ${i.deadline}.`,
    );
  }
  if (availableCash !== null && availableCash.raw < ZERO) {
    warn(
      "NEGATIVE_RAW_CASH",
      `Cash after expenses, fee, reserves and earlier distributions is negative (${dollars(availableCash.raw)}).`,
    );
  }
  if (i.operationsCommencementDate === null) {
    warn(
      "OCD_NOT_SET",
      "The Operations Commencement Date is not set; revenue months are checked from the earliest saved month.",
    );
  }
  if (config.prefAccrualCutoff === "PERIOD_END") {
    warn(
      "RETURN_NOT_PERIOD_END",
      `Preferred Return is measured through the period end ${periodEnd}, not the payment date (setting "prefAccrualCutoff").`,
    );
  }

  let totalDefaultOffset = ZERO;
  let totalTaxOffset = ZERO;
  let totalNet = ZERO;
  for (const l of lines) {
    totalDefaultOffset +=
      l.defaultOffsetBalance + l.defaultOffsetInterest + l.defaultOffsetCosts;
    totalTaxOffset += l.taxAdvanceOffset;
    totalNet += l.net;
  }

  return {
    type,
    isLiquidation,
    periodEnd,
    paymentDate,
    returnMeasuredAsOf,
    availableCash,
    unusedCapital,
    liquidation,
    amount,
    tierC: wf.tierC,
    tierD: wf.tierD,
    tierEPreferred: wf.tierEPreferred,
    tierECommon: wf.tierECommon,
    totalDefaultOffset,
    totalTaxOffset,
    totalNet,
    reserveBalance: reserves.total,
    lines,
    offsetReceipts,
    blockers,
    warnings,
  };
}

/**
 * The string that is hashed (sha256, hex) to detect a change between review
 * and finalize: every bigint as a decimal digit string, lines sorted by
 * stakeholderId.
 */
export function canonicalForHash(
  c: Pick<
    DistributionComputation,
    "type" | "periodEnd" | "paymentDate" | "amount" | "lines"
  >,
): string {
  const lines = [...c.lines]
    .sort((a, b) => compareText(a.stakeholderId, b.stakeholderId))
    .map((l) => ({
      stakeholderId: l.stakeholderId,
      tierC: l.tierC.toString(),
      tierD: l.tierD.toString(),
      tierEPreferred: l.tierEPreferred.toString(),
      tierECommon: l.tierECommon.toString(),
      defaultOffsetBalance: l.defaultOffsetBalance.toString(),
      defaultOffsetInterest: l.defaultOffsetInterest.toString(),
      defaultOffsetCosts: l.defaultOffsetCosts.toString(),
      taxAdvanceOffset: l.taxAdvanceOffset.toString(),
      net: l.net.toString(),
    }));
  return JSON.stringify({
    type: c.type,
    periodEnd: c.periodEnd,
    paymentDate: c.paymentDate,
    amount: c.amount.toString(),
    lines,
  });
}

// ---------------------------------------------------------------------------
// Invariants (checked before anything is written)

function invariant(ok: boolean, message: string): void {
  if (!ok) throw new LlcMathError("DISTRIBUTION_INVARIANT", message);
}

/**
 * No cent created or lost: Σ gross = amount; per line the tiers sum to
 * gross and gross = default offsets + tax advance recovery + net; the tier
 * and netting totals equal the sums of the lines; the planned offset
 * receipts are exactly the Balance offsets; one line per holder.
 */
export function assertComputationInvariants(
  c: Omit<DistributionComputation, "hash">,
): void {
  const seen = new Set<string>();
  let gross = ZERO;
  const sums = {
    c: ZERO,
    d: ZERO,
    eP: ZERO,
    eC: ZERO,
    def: ZERO,
    tax: ZERO,
    net: ZERO,
  };
  let balanceOffsets = ZERO;
  for (const l of c.lines) {
    invariant(!seen.has(l.stakeholderId), `Two lines for ${l.stakeholderId}`);
    seen.add(l.stakeholderId);
    for (const v of [
      l.tierC,
      l.tierD,
      l.tierEPreferred,
      l.tierECommon,
      l.defaultOffsetBalance,
      l.defaultOffsetInterest,
      l.defaultOffsetCosts,
      l.taxAdvanceOffset,
      l.net,
    ]) {
      invariant(v >= ZERO, `Negative amount on the line of ${l.stakeholderId}`);
    }
    invariant(
      l.tierC + l.tierD + l.tierEPreferred + l.tierECommon === l.gross,
      `Tiers do not sum to gross for ${l.stakeholderId}`,
    );
    invariant(
      l.defaultOffsetBalance +
        l.defaultOffsetInterest +
        l.defaultOffsetCosts +
        l.taxAdvanceOffset +
        l.net ===
        l.gross,
      `Offsets and net do not sum to gross for ${l.stakeholderId}`,
    );
    let ob = ZERO;
    let oi = ZERO;
    let oc = ZERO;
    for (const o of l.offsets) {
      ob += o.toBalance;
      oi += o.toInterest;
      oc += o.toCosts;
    }
    invariant(
      ob === l.defaultOffsetBalance &&
        oi === l.defaultOffsetInterest &&
        oc === l.defaultOffsetCosts,
      `Offset applications do not match the line of ${l.stakeholderId}`,
    );
    invariant(
      l.unpaidReturnAfter === l.unpaidReturnBefore - l.tierC &&
        l.unreturnedAfter === l.unreturnedBefore - l.tierD &&
        l.unpaidReturnAfter >= ZERO &&
        l.unreturnedAfter >= ZERO,
      `After-figures are wrong for ${l.stakeholderId}`,
    );
    gross += l.gross;
    sums.c += l.tierC;
    sums.d += l.tierD;
    sums.eP += l.tierEPreferred;
    sums.eC += l.tierECommon;
    sums.def +=
      l.defaultOffsetBalance + l.defaultOffsetInterest + l.defaultOffsetCosts;
    sums.tax += l.taxAdvanceOffset;
    sums.net += l.net;
    balanceOffsets += l.defaultOffsetBalance;
  }
  invariant(gross === c.amount, `Lines sum to ${gross}, not ${c.amount}`);
  invariant(
    sums.c === c.tierC &&
      sums.d === c.tierD &&
      sums.eP === c.tierEPreferred &&
      sums.eC === c.tierECommon &&
      c.tierC + c.tierD + c.tierEPreferred + c.tierECommon === c.amount,
    "Tier totals do not match the lines",
  );
  invariant(
    sums.def === c.totalDefaultOffset &&
      sums.tax === c.totalTaxOffset &&
      sums.net === c.totalNet &&
      c.totalDefaultOffset + c.totalTaxOffset + c.totalNet === c.amount,
    "Netting totals do not match the lines",
  );
  invariant(
    c.offsetReceipts.reduce((s, r) => s + r.amount, ZERO) === balanceOffsets &&
      c.offsetReceipts.every((r) => r.amount > ZERO),
    "Planned offset receipts do not match the Balance offsets",
  );
  if (c.liquidation !== null) {
    invariant(
      c.liquidation.netToMembers === c.amount,
      "Liquidation net does not equal the amount distributed",
    );
  }
}

// ---------------------------------------------------------------------------
// Rows written by finalize and reverse (database column names; cents bigint)

export interface DistributionTotalsRow {
  availableCashCents: Cents | null;
  amountCents: Cents;
  tierCCents: Cents;
  tierDCents: Cents;
  tierEPreferredCents: Cents;
  tierECommonCents: Cents;
  totalDefaultOffsetCents: Cents;
  totalTaxOffsetCents: Cents;
  totalNetCents: Cents;
  reserveBalanceCents: Cents | null;
}

export function distributionTotalsRow(
  c: Omit<DistributionComputation, "hash">,
): DistributionTotalsRow {
  return {
    availableCashCents: c.availableCash?.availableCash ?? null,
    amountCents: c.amount,
    tierCCents: c.tierC,
    tierDCents: c.tierD,
    tierEPreferredCents: c.tierEPreferred,
    tierECommonCents: c.tierECommon,
    totalDefaultOffsetCents: c.totalDefaultOffset,
    totalTaxOffsetCents: c.totalTaxOffset,
    totalNetCents: c.totalNet,
    reserveBalanceCents: c.reserveBalance,
  };
}

export interface DistributionLineRow {
  stakeholderId: string;
  /** 6-dp strings (Decimal columns) */
  preferredUnits: string;
  commonUnits: string;
  unpaidReturnBeforeCents: Cents;
  unreturnedBeforeCents: Cents;
  tierCCents: Cents;
  tierDCents: Cents;
  tierEPreferredCents: Cents;
  tierECommonCents: Cents;
  grossCents: Cents;
  defaultOffsetBalanceCents: Cents;
  defaultOffsetInterestCents: Cents;
  defaultOffsetCostsCents: Cents;
  taxAdvanceOffsetCents: Cents;
  netCents: Cents;
}

/** One row per holder, zero lines included. */
export function distributionLineRows(
  c: Omit<DistributionComputation, "hash">,
): DistributionLineRow[] {
  return c.lines.map((l) => ({
    stakeholderId: l.stakeholderId,
    preferredUnits: microUnitsToDecimalString(l.preferredUnits),
    commonUnits: microUnitsToDecimalString(l.commonUnits),
    unpaidReturnBeforeCents: l.unpaidReturnBefore,
    unreturnedBeforeCents: l.unreturnedBefore,
    tierCCents: l.tierC,
    tierDCents: l.tierD,
    tierEPreferredCents: l.tierEPreferred,
    tierECommonCents: l.tierECommon,
    grossCents: l.gross,
    defaultOffsetBalanceCents: l.defaultOffsetBalance,
    defaultOffsetInterestCents: l.defaultOffsetInterest,
    defaultOffsetCostsCents: l.defaultOffsetCosts,
    taxAdvanceOffsetCents: l.taxAdvanceOffset,
    netCents: l.net,
  }));
}

/** Checks the rows finalize is about to write against the computation (Σ gross = amount, gross = offsets + tax + net). */
export function assertLineRows(
  rows: readonly DistributionLineRow[],
  totals: DistributionTotalsRow,
): void {
  let gross = ZERO;
  let net = ZERO;
  for (const r of rows) {
    invariant(
      r.tierCCents +
        r.tierDCents +
        r.tierEPreferredCents +
        r.tierECommonCents ===
        r.grossCents,
      `Line row tiers do not sum to gross for ${r.stakeholderId}`,
    );
    invariant(
      r.defaultOffsetBalanceCents +
        r.defaultOffsetInterestCents +
        r.defaultOffsetCostsCents +
        r.taxAdvanceOffsetCents +
        r.netCents ===
        r.grossCents,
      `Line row netting does not sum to gross for ${r.stakeholderId}`,
    );
    gross += r.grossCents;
    net += r.netCents;
  }
  invariant(
    gross === totals.amountCents && net === totals.totalNetCents,
    `Line rows sum to ${gross} gross / ${net} net, not ${totals.amountCents} / ${totals.totalNetCents}`,
  );
}

/** The negated lines of a reversal distribution (position columns copied, money columns negated). */
export function reversalLineRows(
  lines: readonly DistributionLineRow[],
): DistributionLineRow[] {
  return lines.map((l) => ({
    stakeholderId: l.stakeholderId,
    preferredUnits: l.preferredUnits,
    commonUnits: l.commonUnits,
    unpaidReturnBeforeCents: l.unpaidReturnBeforeCents,
    unreturnedBeforeCents: l.unreturnedBeforeCents,
    tierCCents: -l.tierCCents,
    tierDCents: -l.tierDCents,
    tierEPreferredCents: -l.tierEPreferredCents,
    tierECommonCents: -l.tierECommonCents,
    grossCents: -l.grossCents,
    defaultOffsetBalanceCents: -l.defaultOffsetBalanceCents,
    defaultOffsetInterestCents: -l.defaultOffsetInterestCents,
    defaultOffsetCostsCents: -l.defaultOffsetCostsCents,
    taxAdvanceOffsetCents: -l.taxAdvanceOffsetCents,
    netCents: -l.netCents,
  }));
}

/** Negated money totals of a reversal distribution; the measured figures (Available Cash, reserve balance) are not flows and are left empty. */
export function reversalTotalsRow(
  t: DistributionTotalsRow,
): DistributionTotalsRow {
  return {
    availableCashCents: null,
    amountCents: -t.amountCents,
    tierCCents: -t.tierCCents,
    tierDCents: -t.tierDCents,
    tierEPreferredCents: -t.tierEPreferredCents,
    tierECommonCents: -t.tierECommonCents,
    totalDefaultOffsetCents: -t.totalDefaultOffsetCents,
    totalTaxOffsetCents: -t.totalTaxOffsetCents,
    totalNetCents: -t.totalNetCents,
    reserveBalanceCents: null,
  };
}

/** What finalize records for one §4.9(iii) application (step 4). */
export interface OffsetWrite {
  stakeholderId: string;
  memberDefaultId: string;
  toBalance: Cents;
  toInterest: Cents;
  toCosts: Cents;
  receipt: PlannedOffsetReceipt | null;
}

export function offsetWrites(
  c: Omit<DistributionComputation, "hash">,
): OffsetWrite[] {
  const out: OffsetWrite[] = [];
  for (const l of c.lines) {
    for (const o of l.offsets) {
      const receipt =
        o.toBalance > ZERO
          ? (c.offsetReceipts.find(
              (r) =>
                r.memberDefaultId === o.memberDefaultId &&
                r.stakeholderId === l.stakeholderId,
            ) ?? null)
          : null;
      invariant(
        o.toBalance === ZERO ||
          (receipt !== null && receipt.amount === o.toBalance),
        `No planned receipt for the Balance offset of ${l.stakeholderId}`,
      );
      out.push({
        stakeholderId: l.stakeholderId,
        memberDefaultId: o.memberDefaultId,
        toBalance: o.toBalance,
        toInterest: o.toInterest,
        toCosts: o.toCosts,
        receipt,
      });
    }
  }
  return out;
}

/** Step 5: tax advance recoveries (§9.2). */
export function taxRecoveryWrites(
  c: Omit<DistributionComputation, "hash">,
): { stakeholderId: string; amount: Cents }[] {
  return c.lines
    .filter((l) => l.taxAdvanceOffset > ZERO)
    .map((l) => ({
      stakeholderId: l.stakeholderId,
      amount: l.taxAdvanceOffset,
    }));
}

/** Step 6 (liquidation only): ESTABLISH for the difference when the WIND_DOWN reserve is below the amount retained. */
export function windDownTopUp(
  windDownReserve: Cents,
  currentWindDownBalance: Cents,
): Cents {
  return windDownReserve > currentWindDownBalance
    ? windDownReserve - currentWindDownBalance
    : ZERO;
}

// ---------------------------------------------------------------------------
// Deadline (R42) for the list page

export interface NextDeadline {
  quarterEnd: IsoDate;
  deadline: IsoDate;
  label: string;
  /** a finalized, unreversed OPERATING or SALE distribution has a period end in that quarter */
  distributed: boolean;
}

/**
 * The next distribution deadline: the deadline of the quarter just ended
 * while it is still ahead and that quarter has no distribution, else the
 * current quarter's.
 */
export function nextDistributionDeadline(
  today: IsoDate,
  cfg: LlcEconomicsConfig,
  distributedPeriodEnds: readonly IsoDate[],
): NextDeadline {
  const current = quarterOf(today);
  const previous = quarterOf(addDays(current.start, -1));
  const describe = (q: ReturnType<typeof quarterOf>): NextDeadline => ({
    quarterEnd: q.end,
    deadline: distributionDeadline(q.end, cfg),
    label: `Q${q.quarter} ${q.year}`,
    distributed: distributedPeriodEnds.some(
      (d) => compareIso(d, q.start) >= 0 && compareIso(d, q.end) <= 0,
    ),
  });
  const prev = describe(previous);
  if (compareIso(prev.deadline, today) >= 0 && !prev.distributed) return prev;
  return describe(current);
}
