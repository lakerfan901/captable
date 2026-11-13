/**
 * Pure parts of the financials service (02-economics.md E13): database rows
 * (normalised to `IsoDate` and `bigint` cents) → the library's `CashLedger`,
 * the organizational-expense counter, the unpaid Management Fee, member-loan
 * states and tax-advance balances. Relative imports only; no Prisma, no `@/`.
 */
import {
  type CashLedger,
  loanAccruedInterest,
  reserveBalances,
} from "../../../lib/llc/available-cash";
import {
  addDays,
  addMonths,
  compareIso,
  type IsoDate,
} from "../../../lib/llc/dates";
import type { RevenueMonth } from "../../../lib/llc/management-fee";
import { type Cents, LlcMathError } from "../../../lib/llc/money";

export type Pool = "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS";

export interface RevenueRow {
  month: IsoDate;
  customerReceiptsCents: Cents;
  passThroughFeesCents: Cents;
  otherIncomeCents: Cents;
  assetSaleProceedsCents: Cents;
  insuranceProceedsCents: Cents;
  managementFeeCents: Cents;
}

export interface ExpenseRow {
  incurredOn: IsoDate;
  amountCents: Cents; // negative on a reversal row
  fundingSource: Pool;
  category: string;
  countsTowardOrgCap: boolean;
}

export interface ReserveRow {
  effectiveOn: IsoDate;
  kind: string;
  type: "ESTABLISH" | "RELEASE";
  amountCents: Cents; // negative only on a reversal row
  fundingSource: Pool;
  releaseTo: Pool | null;
}

export interface CashLedgerRows {
  revenue: readonly RevenueRow[];
  expenses: readonly ExpenseRow[];
  /** in effectiveOn, createdAt order */
  reserves: readonly ReserveRow[];
  defaultPayments: readonly {
    paidOn: IsoDate;
    toInterestCents: Cents;
    toCostsCents: Cents;
  }[];
  loanPayments: readonly {
    paidOn: IsoDate;
    principalCents: Cents;
    interestCents: Cents;
    fundingSource: Pool;
  }[];
  loans: readonly { madeOn: IsoDate; principalCents: Cents }[];
  /** FINALIZED, non-reversal rows */
  distributions: readonly {
    type: "OPERATING" | "RETURN_OF_UNUSED_CAPITAL" | "SALE_OR_LIQUIDATION";
    periodEnd: IsoDate;
    paymentDate: IsoDate;
    amountCents: Cents | null;
  }[];
  /** LoadedLedger.cashCapital */
  cashCapital: readonly { on: IsoDate; amount: Cents }[];
}

export function toRevenueMonth(r: RevenueRow): RevenueMonth {
  return {
    month: r.month,
    customerReceipts: r.customerReceiptsCents,
    passThroughFees: r.passThroughFeesCents,
    otherIncome: r.otherIncomeCents,
    assetSaleProceeds: r.assetSaleProceedsCents,
    insuranceProceeds: r.insuranceProceedsCents,
    managementFee: r.managementFeeCents,
  };
}

/** A reversal row (negative amount) becomes the opposite type with a positive amount. */
export function toReserveEntries(
  rows: readonly ReserveRow[],
): CashLedger["reserves"] {
  return rows.map((r) => {
    const reversal = r.amountCents < 0n;
    const type = reversal
      ? r.type === "ESTABLISH"
        ? "RELEASE"
        : "ESTABLISH"
      : r.type;
    return {
      on: r.effectiveOn,
      kind: r.kind,
      type,
      amount: reversal ? -r.amountCents : r.amountCents,
      fundingSource: r.fundingSource,
      releaseTo: type === "RELEASE" ? r.releaseTo : null,
    };
  });
}

export function toCashLedger(rows: CashLedgerRows): CashLedger {
  return {
    months: rows.revenue.map(toRevenueMonth),
    expenses: rows.expenses.map((e) => ({
      on: e.incurredOn,
      amount: e.amountCents,
      fundingSource: e.fundingSource,
      category: e.category,
      countsTowardOrgCap: e.countsTowardOrgCap,
    })),
    reserves: toReserveEntries(rows.reserves),
    defaultIncome: rows.defaultPayments.map((p) => ({
      on: p.paidOn,
      amount: p.toInterestCents + p.toCostsCents,
    })),
    loanPayments: rows.loanPayments.map((p) => ({
      on: p.paidOn,
      principal: p.principalCents,
      interest: p.interestCents,
      fundingSource: p.fundingSource,
    })),
    loanProceeds: rows.loans.map((l) => ({
      on: l.madeOn,
      amount: l.principalCents,
    })),
    distributions: rows.distributions.map((d) => ({
      on: d.type === "RETURN_OF_UNUSED_CAPITAL" ? d.paymentDate : d.periodEnd,
      type: d.type,
      gross: d.amountCents ?? 0n,
    })),
    capitalReceived: rows.cashCapital.map((c) => ({
      on: c.on,
      amount: c.amount,
    })),
  };
}

/**
 * Replays the whole reserve ledger (every date) and returns the error message
 * when any pool of any kind would go negative at any point, else null.
 */
export function reserveLedgerError(rows: readonly ReserveRow[]): string | null {
  try {
    reserveBalances(toReserveEntries(rows), "9999-12-31");
    return null;
  } catch (e) {
    if (e instanceof LlcMathError) return e.message;
    throw e;
  }
}

export function firstOfMonth(d: IsoDate): IsoDate {
  return `${d.slice(0, 8)}01`;
}

export function lastOfMonth(d: IsoDate): IsoDate {
  return addDays(addMonths(firstOfMonth(d), 1), -1);
}

/** Last day of the last month that is complete on `on` (`on` itself when it is a month end). */
export function lastCompleteMonthEnd(on: IsoDate): IsoDate {
  return lastOfMonth(on) === on ? on : addDays(firstOfMonth(on), -1);
}

/**
 * R22 "accrued monthly and paid quarterly": the fee accrued in months complete
 * on `on`, less every Management Fee payment ever recorded (net of reversals).
 */
export function unpaidFeeThrough(
  months: readonly { month: IsoDate; managementFeeCents: Cents }[],
  feePayments: readonly { amountCents: Cents }[],
  on: IsoDate,
): Cents {
  const end = lastCompleteMonthEnd(on);
  let accrued = 0n;
  for (const m of months) {
    if (compareIso(m.month, end) <= 0) accrued += m.managementFeeCents;
  }
  let paid = 0n;
  for (const p of feePayments) paid += p.amountCents;
  return accrued - paid;
}

/** R23 counter: counted expenses + counted Manager payments (reversals are negative). */
export function orgCapCounted(
  expenses: readonly { countsTowardOrgCap: boolean; amountCents: Cents }[],
  payments: readonly { countsTowardOrgCap: boolean; amountCents: Cents }[],
): Cents {
  let counted = 0n;
  for (const e of expenses) if (e.countsTowardOrgCap) counted += e.amountCents;
  for (const p of payments) if (p.countsTowardOrgCap) counted += p.amountCents;
  return counted;
}

export interface LoanState {
  principalOutstanding: Cents;
  accruedInterest: Cents;
  interestPaid: Cents;
  pastMaturity: boolean;
}

/** R25: principal outstanding, simple actual/365 interest accrued through `asOf`, interest paid. */
export function loanState(
  loan: {
    madeOn: IsoDate;
    maturityOn: IsoDate;
    principalCents: Cents;
    interestBps: number;
  },
  payments: readonly {
    paidOn: IsoDate;
    principalCents: Cents;
    interestCents: Cents;
  }[],
  asOf: IsoDate,
): LoanState {
  if (compareIso(loan.madeOn, asOf) > 0) {
    return {
      principalOutstanding: 0n,
      accruedInterest: 0n,
      interestPaid: 0n,
      pastMaturity: false,
    };
  }
  const dated = payments
    .filter((p) => compareIso(p.paidOn, asOf) <= 0)
    .sort((a, b) => compareIso(a.paidOn, b.paidOn));
  const segments: { from: IsoDate; to: IsoDate; principal: Cents }[] = [];
  let outstanding = loan.principalCents;
  let interestPaid = 0n;
  let cursor = loan.madeOn;
  for (const p of dated) {
    const on = compareIso(p.paidOn, cursor) < 0 ? cursor : p.paidOn;
    segments.push({ from: cursor, to: on, principal: outstanding });
    outstanding -= p.principalCents;
    interestPaid += p.interestCents;
    cursor = on;
  }
  segments.push({ from: cursor, to: asOf, principal: outstanding });
  return {
    principalOutstanding: outstanding,
    accruedInterest: loanAccruedInterest({
      principalOutstandingSegments: segments,
      bps: loan.interestBps,
    }),
    interestPaid,
    pastMaturity: compareIso(loan.maturityOn, asOf) <= 0 && outstanding > 0n,
  };
}

/** Σ advances − Σ recoveries per stakeholder (reversal rows carry negative amounts). */
export function advancesOutstanding(
  advances: readonly { stakeholderId: string; amountCents: Cents }[],
  recoveries: readonly { stakeholderId: string; amountCents: Cents }[],
): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const a of advances) {
    out.set(a.stakeholderId, (out.get(a.stakeholderId) ?? 0n) + a.amountCents);
  }
  for (const r of recoveries) {
    out.set(r.stakeholderId, (out.get(r.stakeholderId) ?? 0n) - r.amountCents);
  }
  return out;
}

export interface RevenueYearRow extends RevenueRow {
  utilizationBps: number | null;
  notes: string | null;
  managementFeeBps: number | null;
  grossRevenue: Cents;
  saved: boolean;
  locked: boolean;
}

/** 12 rows for `year`; missing months are zeros with `saved: false`. */
export function revenueYearRows(
  year: number,
  saved: readonly (RevenueRow & {
    utilizationBps: number | null;
    notes: string | null;
    managementFeeBps: number;
  })[],
  booksClosedThrough: IsoDate | null,
): RevenueYearRow[] {
  const byMonth = new Map(saved.map((r) => [r.month, r]));
  const rows: RevenueYearRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
    const locked =
      booksClosedThrough !== null &&
      compareIso(lastOfMonth(month), booksClosedThrough) <= 0;
    const r = byMonth.get(month);
    if (r) {
      rows.push({
        ...r,
        grossRevenue: r.customerReceiptsCents - r.passThroughFeesCents,
        saved: true,
        locked,
      });
    } else {
      rows.push({
        month,
        customerReceiptsCents: 0n,
        passThroughFeesCents: 0n,
        otherIncomeCents: 0n,
        assetSaleProceedsCents: 0n,
        insuranceProceedsCents: 0n,
        managementFeeCents: 0n,
        managementFeeBps: null,
        utilizationBps: null,
        notes: null,
        grossRevenue: 0n,
        saved: false,
        locked,
      });
    }
  }
  return rows;
}
