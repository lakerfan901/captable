// Month records of the financial dashboard and their aggregation
// (04-investor-portal.md 5.9, rules P33, P36, P37). Pure: relative imports
// only, no clock, no database.
//
// This file is safe for the browser: the investor view aggregates stored
// month rows with `aggregate` (5.9 "Aggregation approach"). It does no
// arithmetic on ledger rows. The month records are BUILT from the existing
// economics functions by `./financial-series-build` (server side only).
//
// Conventions (02-economics.md): money is bigint cents; units are bigint
// micro-units (6 decimals); rates and ratios are integer basis points; dates
// are "YYYY-MM-DD" strings and a month is its first day. In stored JSON
// (`FinancialSnapshot.data`) cents are safe-integer numbers and units 6-dp
// strings (`fundMonthToJson` / `fundMonthFromJson`).
//
// Rounding rules (every ratio, stated once here and tested):
// - DPI: roundDiv(cumulative × 10000, paidIn) basis points of "x", half away
//   from zero; null when paid-in is zero or less. Shown with two decimals
//   ("0.12x"): roundDiv(bps, 100) hundredths, half away from zero.
// - Utilization over several months: the mean of the months that have a
//   value, roundDiv(Σ bps, n), half away from zero; null when no month has
//   one. Identical to `averageUtilizationBps` of `buildPeriodEconomics`
//   (Math.round of a non-negative mean of integers; tested for agreement).
// - Percentage change: see `changeOf` in ./financial-periods.

import { z } from "zod";
import { compareIso, type IsoDate } from "./dates";
import {
  type Change,
  changeOf,
  comparisonPeriod,
  type Grain,
  groupByGrain,
  type MonthKey,
  type MonthRange,
  type Period,
} from "./financial-periods";
import {
  type Cents,
  LlcMathError,
  type MicroUnits,
  microUnitsFromDecimal,
  microUnitsToDecimalString,
  roundDiv,
} from "./money";

export const FINANCIAL_SERIES_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Month records

/** The fund figures of a month (or of an aggregated period). */
export interface FundValues {
  // Income (sum)
  grossRevenue: Cents;
  otherIncome: Cents;
  assetSaleProceeds: Cents;
  insuranceProceeds: Cents;
  // Expenses (sum)
  totalExpenses: Cents;
  operatingExpenses: Cents;
  capitalFundedExpenses: Cents;
  /** sorted by category; sums to totalExpenses */
  expensesByCategory: { category: string; amount: Cents }[];
  // Management Fee
  managementFeeAccrued: Cents; // sum
  managementFeePaid: Cents; // sum
  managementFeeUnpaid: Cents; // end
  /** grossRevenue + otherIncome − operatingExpenses − managementFeeAccrued (sum) */
  netOperatingIncome: Cents;
  // Reserves
  reserveBalance: Cents; // end
  /** sorted by kind; sums to reserveBalance (end) */
  reservesByKind: { kind: string; balance: Cents }[];
  minimumReserve: Cents; // end
  reservesEstablished: Cents; // sum
  reservesReleased: Cents; // sum
  // Cash
  availableCash: Cents; // end
  // Distributions (sum), by payment date; tiers C, D, E
  distributions: {
    preferredReturn: Cents;
    returnOfCapital: Cents;
    residualPreferred: Cents;
    residualCommon: Cents;
    gross: Cents;
  };
  // Capital
  capitalReceived: Cents; // sum
  paidInCapital: Cents; // end
  unreturnedCapital: Cents; // end
  preferredReturnAccruedToDate: Cents; // end
  preferredReturnPaidToDate: Cents; // end
  preferredReturnUnpaid: Cents; // end
  committed: Cents; // end
  uncalled: Cents; // end
  // Operations
  /** typed monthly percentage (0–10000); mean of the months with a value */
  utilizationBps: number | null;
  memberLoansOutstanding: Cents; // end
  orgExpenseCap: { counted: Cents; limit: Cents }; // end
}

export interface FundMonth extends FundValues {
  schemaVersion: typeof FINANCIAL_SERIES_SCHEMA_VERSION;
  month: MonthKey;
  /** the date the end-of-month figures are taken at: the month end, or "today" for the month in progress */
  asOf: IsoDate;
  /** the live view's current month: its figures are not final (5.9) */
  inProgress: boolean;
}

/** One holder's figures of a month (or of an aggregated period). */
export interface HolderValues {
  // sum
  contributions: Cents;
  credits: Cents;
  forfeited: Cents;
  preferredReturnAccrued: Cents;
  preferredReturnPaid: Cents;
  capitalReturned: Cents;
  residualPaid: Cents;
  grossDistributions: Cents;
  defaultOffsets: Cents;
  taxAdvanceOffsets: Cents;
  netPaid: Cents;
  // end
  paidIn: Cents;
  unreturnedCapital: Cents;
  preferredUnits: MicroUnits;
  commonUnits: MicroUnits;
  /** pctString of the Preferred class ("12.3457") */
  preferredPct: string;
  preferredReturnUnpaid: Cents;
  committed: Cents;
  uncalled: Cents;
  calledOutstanding: Cents;
}

export interface HolderMonth extends HolderValues {
  schemaVersion: typeof FINANCIAL_SERIES_SCHEMA_VERSION;
  holderId: string;
  month: MonthKey;
  asOf: IsoDate;
  inProgress: boolean;
}

// ---------------------------------------------------------------------------
// Metric catalogue

export type MetricRule =
  /** summed over the months */
  | "sum"
  /** the value of the last month of the period */
  | "end"
  /** mean of the months with a value (utilization) */
  | "mean"
  /** derived from the whole series at display time (never stored) */
  | "derived";

export type MetricUnit = "cents" | "bps" | "dpiBps";

export interface MetricDef<V> {
  key: string;
  label: string;
  unit: MetricUnit;
  rule: MetricRule;
  /**
   * Decision 9.2 #16: every metric can be switched off for the portal in this
   * one list. Default: all of the 5.9 catalogue is shown.
   */
  portal: boolean;
  get: (v: V) => bigint | number | null;
}

/** The fund values of an aggregated period: the stored fields plus the derived ones. */
export interface FundPeriodValues extends FundValues {
  /** Σ distributions.gross of every month from inception through the period end */
  cumulativeDistributions: Cents;
  /** preferredReturn + returnOfCapital + residualPreferred of the period */
  distributionsToPreferred: Cents;
  /** the same, cumulative from inception through the period end */
  cumulativeDistributionsToPreferred: Cents;
  /** DPI of the Preferred class at the period end (see `dpiBps`) */
  dpiBps: bigint | null;
}

export interface HolderPeriodValues extends HolderValues {
  /** Σ grossDistributions from the holder's first month through the period end */
  cumulativeGrossDistributions: Cents;
  /** holder DPI: cumulative gross distributions ÷ paidIn (see `dpiBps`) */
  dpiBps: bigint | null;
}

const fund = (
  key: string,
  label: string,
  rule: MetricRule,
  get: (v: FundPeriodValues) => bigint | number | null,
  unit: MetricUnit = "cents",
): MetricDef<FundPeriodValues> => ({
  key,
  label,
  unit,
  rule,
  portal: true,
  get,
});

/** The fund metric catalogue of 5.9 (scalar metrics; breakdowns are `expensesByCategory` and `reservesByKind`). */
export const FUND_METRICS: readonly MetricDef<FundPeriodValues>[] = [
  fund("grossRevenue", "Gross Revenue", "sum", (v) => v.grossRevenue),
  fund("otherIncome", "Other income", "sum", (v) => v.otherIncome),
  fund(
    "assetSaleProceeds",
    "Asset-sale proceeds",
    "sum",
    (v) => v.assetSaleProceeds,
  ),
  fund(
    "insuranceProceeds",
    "Insurance proceeds",
    "sum",
    (v) => v.insuranceProceeds,
  ),
  fund("totalExpenses", "Expenses", "sum", (v) => v.totalExpenses),
  fund(
    "operatingExpenses",
    "Operating expenses",
    "sum",
    (v) => v.operatingExpenses,
  ),
  fund(
    "capitalFundedExpenses",
    "Expenses paid from capital",
    "sum",
    (v) => v.capitalFundedExpenses,
  ),
  fund(
    "managementFeeAccrued",
    "Management Fee accrued",
    "sum",
    (v) => v.managementFeeAccrued,
  ),
  fund(
    "managementFeePaid",
    "Management Fee paid",
    "sum",
    (v) => v.managementFeePaid,
  ),
  fund(
    "managementFeeUnpaid",
    "Management Fee unpaid",
    "end",
    (v) => v.managementFeeUnpaid,
  ),
  fund(
    "netOperatingIncome",
    "Net operating income (before reserves and distributions)",
    "sum",
    (v) => v.netOperatingIncome,
  ),
  fund("reserveBalance", "Reserve balance", "end", (v) => v.reserveBalance),
  fund(
    "minimumReserve",
    "Minimum operating reserve",
    "end",
    (v) => v.minimumReserve,
  ),
  fund(
    "reservesEstablished",
    "Reserves set aside",
    "sum",
    (v) => v.reservesEstablished,
  ),
  fund(
    "reservesReleased",
    "Reserves released",
    "sum",
    (v) => v.reservesReleased,
  ),
  fund("availableCash", "Available Cash", "end", (v) => v.availableCash),
  fund(
    "distributions.preferredReturn",
    "Distributions: preferred return",
    "sum",
    (v) => v.distributions.preferredReturn,
  ),
  fund(
    "distributions.returnOfCapital",
    "Distributions: return of capital",
    "sum",
    (v) => v.distributions.returnOfCapital,
  ),
  fund(
    "distributions.residualPreferred",
    "Distributions: residual (Preferred)",
    "sum",
    (v) => v.distributions.residualPreferred,
  ),
  fund(
    "distributions.residualCommon",
    "Distributions: residual (Common)",
    "sum",
    (v) => v.distributions.residualCommon,
  ),
  fund(
    "distributions.gross",
    "Distributions paid",
    "sum",
    (v) => v.distributions.gross,
  ),
  fund(
    "distributionsToPreferred",
    "Distributions to the Preferred class",
    "derived",
    (v) => v.distributionsToPreferred,
  ),
  fund(
    "cumulativeDistributions",
    "Cumulative distributions",
    "derived",
    (v) => v.cumulativeDistributions,
  ),
  fund(
    "cumulativeDistributionsToPreferred",
    "Cumulative distributions to the Preferred class",
    "derived",
    (v) => v.cumulativeDistributionsToPreferred,
  ),
  fund("capitalReceived", "Capital received", "sum", (v) => v.capitalReceived),
  fund("paidInCapital", "Paid-in capital", "end", (v) => v.paidInCapital),
  fund(
    "unreturnedCapital",
    "Unreturned capital",
    "end",
    (v) => v.unreturnedCapital,
  ),
  fund(
    "preferredReturnAccruedToDate",
    "Preferred return accrued to date",
    "end",
    (v) => v.preferredReturnAccruedToDate,
  ),
  fund(
    "preferredReturnPaidToDate",
    "Preferred return paid to date",
    "end",
    (v) => v.preferredReturnPaidToDate,
  ),
  fund(
    "preferredReturnUnpaid",
    "Unpaid preferred return",
    "end",
    (v) => v.preferredReturnUnpaid,
  ),
  fund("committed", "Capital committed", "end", (v) => v.committed),
  fund("uncalled", "Uncalled capital", "end", (v) => v.uncalled),
  fund("dpiBps", "DPI (Preferred class)", "derived", (v) => v.dpiBps, "dpiBps"),
  fund(
    "utilizationBps",
    "Utilization (as reported by the Manager)",
    "mean",
    (v) => v.utilizationBps,
    "bps",
  ),
  fund(
    "memberLoansOutstanding",
    "Member loans outstanding",
    "end",
    (v) => v.memberLoansOutstanding,
  ),
  fund(
    "orgExpenseCap.counted",
    "Organizational expenses counted (6.21)",
    "end",
    (v) => v.orgExpenseCap.counted,
  ),
  fund(
    "orgExpenseCap.limit",
    "Organizational expense cap (6.21)",
    "end",
    (v) => v.orgExpenseCap.limit,
  ),
];

const holder = (
  key: string,
  label: string,
  rule: MetricRule,
  get: (v: HolderPeriodValues) => bigint | number | null,
  unit: MetricUnit = "cents",
): MetricDef<HolderPeriodValues> => ({
  key,
  label,
  unit,
  rule,
  portal: true,
  get,
});

/** The holder metric catalogue of 5.9 (units and the class percentage are end values, not in this list). */
export const HOLDER_METRICS: readonly MetricDef<HolderPeriodValues>[] = [
  holder("contributions", "Contributions", "sum", (v) => v.contributions),
  holder("credits", "Credits", "sum", (v) => v.credits),
  holder("forfeited", "Forfeited", "sum", (v) => v.forfeited),
  holder(
    "preferredReturnAccrued",
    "Preferred return accrued",
    "sum",
    (v) => v.preferredReturnAccrued,
  ),
  holder(
    "preferredReturnPaid",
    "Preferred return paid",
    "sum",
    (v) => v.preferredReturnPaid,
  ),
  holder(
    "capitalReturned",
    "Capital returned",
    "sum",
    (v) => v.capitalReturned,
  ),
  holder("residualPaid", "Residual paid", "sum", (v) => v.residualPaid),
  holder(
    "grossDistributions",
    "Distributions received",
    "sum",
    (v) => v.grossDistributions,
  ),
  holder(
    "defaultOffsets",
    "Offsets for defaults",
    "sum",
    (v) => v.defaultOffsets,
  ),
  holder(
    "taxAdvanceOffsets",
    "Offsets for tax advances",
    "sum",
    (v) => v.taxAdvanceOffsets,
  ),
  holder("netPaid", "Net paid", "sum", (v) => v.netPaid),
  holder("paidIn", "Paid in", "end", (v) => v.paidIn),
  holder(
    "unreturnedCapital",
    "Unreturned capital",
    "end",
    (v) => v.unreturnedCapital,
  ),
  holder(
    "preferredReturnUnpaid",
    "Unpaid preferred return",
    "end",
    (v) => v.preferredReturnUnpaid,
  ),
  holder("committed", "Commitment", "end", (v) => v.committed),
  holder("uncalled", "Uncalled", "end", (v) => v.uncalled),
  holder(
    "calledOutstanding",
    "Called and outstanding",
    "end",
    (v) => v.calledOutstanding,
  ),
  holder(
    "cumulativeGrossDistributions",
    "Distributions received to date",
    "derived",
    (v) => v.cumulativeGrossDistributions,
  ),
  holder("dpiBps", "My DPI", "derived", (v) => v.dpiBps, "dpiBps"),
];

// ---------------------------------------------------------------------------
// Ratios

/**
 * DPI in basis points of "x" (10000 = 1.00x): roundDiv(distributed × 10000,
 * paidIn), half away from zero. Null when paid-in is zero or less.
 */
export function dpiBps(distributed: Cents, paidIn: Cents): bigint | null {
  if (paidIn <= 0n) return null;
  return roundDiv(distributed * 10_000n, paidIn);
}

/** 1200n → "0.12x"; 12500n → "1.25x"; null → "—". Two decimals, half away from zero. */
export function formatDpi(bps: bigint | null): string {
  if (bps === null) return "—";
  const hundredths = roundDiv(bps, 100n);
  const neg = hundredths < 0n;
  const abs = neg ? -hundredths : hundredths;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${abs / 100n}.${frac}x`;
}

/** Mean of the values that are not null: roundDiv(Σ, n), half away from zero; null when none. */
export function meanBps(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  const total = present.reduce((a, b) => a + BigInt(b), 0n);
  return Number(roundDiv(total, BigInt(present.length)));
}

// ---------------------------------------------------------------------------
// Combining months

function sumBy<T>(rows: readonly T[], f: (r: T) => bigint): bigint {
  return rows.reduce((acc, r) => acc + f(r), 0n);
}

function sumBreakdown(
  lists: readonly (readonly { label: string; v: Cents }[])[],
): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const list of lists) {
    for (const row of list) {
      out.set(row.label, (out.get(row.label) ?? 0n) + row.v);
    }
  }
  return out;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Combines month values (oldest first, at least one) by the rule of each field. */
export function combineFundValues(months: readonly FundValues[]): FundValues {
  const last = months[months.length - 1];
  if (!last) throw new LlcMathError("EMPTY", "No months to combine");
  const s = (f: (m: FundValues) => Cents) => sumBy(months, f);
  const categories = sumBreakdown(
    months.map((m) =>
      m.expensesByCategory.map((c) => ({ label: c.category, v: c.amount })),
    ),
  );
  return {
    grossRevenue: s((m) => m.grossRevenue),
    otherIncome: s((m) => m.otherIncome),
    assetSaleProceeds: s((m) => m.assetSaleProceeds),
    insuranceProceeds: s((m) => m.insuranceProceeds),
    totalExpenses: s((m) => m.totalExpenses),
    operatingExpenses: s((m) => m.operatingExpenses),
    capitalFundedExpenses: s((m) => m.capitalFundedExpenses),
    expensesByCategory: [...categories]
      .sort(([a], [b]) => byText(a, b))
      .map(([category, amount]) => ({ category, amount })),
    managementFeeAccrued: s((m) => m.managementFeeAccrued),
    managementFeePaid: s((m) => m.managementFeePaid),
    managementFeeUnpaid: last.managementFeeUnpaid,
    netOperatingIncome: s((m) => m.netOperatingIncome),
    reserveBalance: last.reserveBalance,
    reservesByKind: last.reservesByKind.map((k) => ({ ...k })),
    minimumReserve: last.minimumReserve,
    reservesEstablished: s((m) => m.reservesEstablished),
    reservesReleased: s((m) => m.reservesReleased),
    availableCash: last.availableCash,
    distributions: {
      preferredReturn: s((m) => m.distributions.preferredReturn),
      returnOfCapital: s((m) => m.distributions.returnOfCapital),
      residualPreferred: s((m) => m.distributions.residualPreferred),
      residualCommon: s((m) => m.distributions.residualCommon),
      gross: s((m) => m.distributions.gross),
    },
    capitalReceived: s((m) => m.capitalReceived),
    paidInCapital: last.paidInCapital,
    unreturnedCapital: last.unreturnedCapital,
    preferredReturnAccruedToDate: last.preferredReturnAccruedToDate,
    preferredReturnPaidToDate: last.preferredReturnPaidToDate,
    preferredReturnUnpaid: last.preferredReturnUnpaid,
    committed: last.committed,
    uncalled: last.uncalled,
    utilizationBps: meanBps(months.map((m) => m.utilizationBps)),
    memberLoansOutstanding: last.memberLoansOutstanding,
    orgExpenseCap: { ...last.orgExpenseCap },
  };
}

export const ZERO_HOLDER_VALUES: HolderValues = {
  contributions: 0n,
  credits: 0n,
  forfeited: 0n,
  preferredReturnAccrued: 0n,
  preferredReturnPaid: 0n,
  capitalReturned: 0n,
  residualPaid: 0n,
  grossDistributions: 0n,
  defaultOffsets: 0n,
  taxAdvanceOffsets: 0n,
  netPaid: 0n,
  paidIn: 0n,
  unreturnedCapital: 0n,
  preferredUnits: 0n,
  commonUnits: 0n,
  preferredPct: "0.0000",
  preferredReturnUnpaid: 0n,
  committed: 0n,
  uncalled: 0n,
  calledOutstanding: 0n,
};

/** Combines a holder's month values (oldest first, at least one) by the rule of each field. */
export function combineHolderValues(
  months: readonly HolderValues[],
): HolderValues {
  const last = months[months.length - 1];
  if (!last) throw new LlcMathError("EMPTY", "No months to combine");
  const s = (f: (m: HolderValues) => Cents) => sumBy(months, f);
  return {
    contributions: s((m) => m.contributions),
    credits: s((m) => m.credits),
    forfeited: s((m) => m.forfeited),
    preferredReturnAccrued: s((m) => m.preferredReturnAccrued),
    preferredReturnPaid: s((m) => m.preferredReturnPaid),
    capitalReturned: s((m) => m.capitalReturned),
    residualPaid: s((m) => m.residualPaid),
    grossDistributions: s((m) => m.grossDistributions),
    defaultOffsets: s((m) => m.defaultOffsets),
    taxAdvanceOffsets: s((m) => m.taxAdvanceOffsets),
    netPaid: s((m) => m.netPaid),
    paidIn: last.paidIn,
    unreturnedCapital: last.unreturnedCapital,
    preferredUnits: last.preferredUnits,
    commonUnits: last.commonUnits,
    preferredPct: last.preferredPct,
    preferredReturnUnpaid: last.preferredReturnUnpaid,
    committed: last.committed,
    uncalled: last.uncalled,
    calledOutstanding: last.calledOutstanding,
  };
}

function fundValuesOf(m: FundMonth): FundValues {
  const {
    schemaVersion: _v,
    month: _m,
    asOf: _a,
    inProgress: _p,
    ...values
  } = m;
  return values;
}

function holderValuesOf(m: HolderMonth): HolderValues {
  const {
    schemaVersion: _v,
    holderId: _h,
    month: _m,
    asOf: _a,
    inProgress: _p,
    ...values
  } = m;
  return values;
}

// ---------------------------------------------------------------------------
// Aggregation

export interface AggregatedPeriod<V> extends Period {
  /** months of the period for which a record exists (inside the range) */
  presentMonths: MonthKey[];
  /** false when no month of the period has data: shown as a gap, never a zero */
  hasData: boolean;
  /**
   * true when the period lacks months (cut by the range, before inception,
   * after the published-through date, not yet ended) or contains the month
   * in progress. A partial period is shown, flagged, and never compared.
   */
  partial: boolean;
  inProgress: boolean;
  values: V | null;
}

export type FundPeriod = AggregatedPeriod<FundPeriodValues>;
export type HolderPeriod = AggregatedPeriod<HolderPeriodValues>;

function sortedUnique<T extends { month: MonthKey }>(
  rows: readonly T[],
  what: string,
): T[] {
  const sorted = [...rows].sort((a, b) => compareIso(a.month, b.month));
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] as T).month === (sorted[i - 1] as T).month) {
      throw new LlcMathError(
        "DUPLICATE_MONTH",
        `Two ${what} records for ${(sorted[i] as T).month}`,
      );
    }
  }
  return sorted;
}

/**
 * P37: the fund series by `grain` over `range`. `months` must be EVERY month
 * record from inception (cumulative distributions and DPI run from the first
 * record, then the periods are sliced to the range). Inception is the first
 * record's month unless given.
 */
export function aggregate(
  months: readonly FundMonth[],
  grain: Grain,
  range: MonthRange,
  opts: { inceptionMonth?: MonthKey } = {},
): FundPeriod[] {
  const rows = sortedUnique(months, "fund");
  const inception = opts.inceptionMonth ?? rows[0]?.month ?? range.from;
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return groupByGrain(range, grain, inception).map((p) => {
    const present = p.rangeMonths
      .map((m) => byMonth.get(m))
      .filter((r): r is FundMonth => r !== undefined);
    const inProgress = present.some((r) => r.inProgress);
    const partial = present.length < p.months.length || inProgress;
    const base = {
      ...p,
      presentMonths: present.map((r) => r.month),
      hasData: present.length > 0,
      partial,
      inProgress,
    };
    if (present.length === 0) return { ...base, values: null };
    const values = combineFundValues(present.map(fundValuesOf));
    const lastMonth = (present[present.length - 1] as FundMonth).month;
    const toDate = rows.filter((r) => compareIso(r.month, lastMonth) <= 0);
    const toPreferred = (v: FundValues) =>
      v.distributions.preferredReturn +
      v.distributions.returnOfCapital +
      v.distributions.residualPreferred;
    const cumulativeDistributionsToPreferred = sumBy(toDate, toPreferred);
    return {
      ...base,
      values: {
        ...values,
        cumulativeDistributions: sumBy(toDate, (r) => r.distributions.gross),
        distributionsToPreferred: toPreferred(values),
        cumulativeDistributionsToPreferred,
        dpiBps: dpiBps(
          cumulativeDistributionsToPreferred,
          values.paidInCapital,
        ),
      },
    };
  });
}

/**
 * One holder's series, on the calendar of the fund months (the months that
 * exist for the viewer: inception through the published-through date). A
 * month of the calendar without a holder record is a month in which the
 * holder had no position and no movement: zeros. `holderMonths` must all be
 * of one holder and include every record of that holder from its first.
 */
export function aggregateHolder(
  holderMonths: readonly HolderMonth[],
  fundMonths: readonly Pick<FundMonth, "month" | "inProgress">[],
  grain: Grain,
  range: MonthRange,
  opts: { inceptionMonth?: MonthKey } = {},
): HolderPeriod[] {
  if (new Set(holderMonths.map((r) => r.holderId)).size > 1) {
    throw new LlcMathError("MIXED_HOLDERS", "Records of several holders");
  }
  const rows = sortedUnique(holderMonths, "holder");
  const calendar = sortedUnique(fundMonths, "fund");
  const inception = opts.inceptionMonth ?? calendar[0]?.month ?? range.from;
  const calendarByMonth = new Map(calendar.map((c) => [c.month, c]));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return groupByGrain(range, grain, inception).map((p) => {
    const present = p.rangeMonths.filter((m) => calendarByMonth.has(m));
    const inProgress = present.some(
      (m) => calendarByMonth.get(m)?.inProgress === true,
    );
    const partial = present.length < p.months.length || inProgress;
    const base = {
      ...p,
      presentMonths: present,
      hasData: present.length > 0,
      partial,
      inProgress,
    };
    if (present.length === 0) return { ...base, values: null };
    const lastMonth = present[present.length - 1] as MonthKey;
    const monthValues = present.map((m) => {
      const r = byMonth.get(m);
      return r ? holderValuesOf(r) : ZERO_HOLDER_VALUES;
    });
    const values = combineHolderValues(monthValues);
    const cumulativeGrossDistributions = sumBy(
      rows.filter(
        (r) =>
          compareIso(r.month, lastMonth) <= 0 && calendarByMonth.has(r.month),
      ),
      (r) => r.grossDistributions,
    );
    return {
      ...base,
      values: {
        ...values,
        cumulativeGrossDistributions,
        dpiBps: dpiBps(cumulativeGrossDistributions, values.paidIn),
      },
    };
  });
}

/** The holder's own records (P36: the server reads by the holder of the context; this is the pure filter). */
export function holderSlice(
  holderMonths: readonly HolderMonth[],
  holderId: string,
): HolderMonth[] {
  return holderMonths.filter((m) => m.holderId === holderId);
}

// ---------------------------------------------------------------------------
// Comparison

export type MetricChanges = Record<string, Change>;

/**
 * Change of every metric of `catalogue` between two aggregated periods. A
 * partial period on either side gives status PARTIAL for every metric; a
 * missing comparison gives NOT_AVAILABLE.
 */
export function comparePeriodValues<V>(
  catalogue: readonly MetricDef<V>[],
  current: AggregatedPeriod<V> | null,
  previous: AggregatedPeriod<V> | null,
): MetricChanges {
  const out: MetricChanges = {};
  const side = (p: AggregatedPeriod<V> | null, def: MetricDef<V>) => {
    if (p === null) return null;
    const raw = p.values === null ? null : def.get(p.values);
    return {
      value: raw === null ? null : BigInt(raw),
      partial: p.partial,
    };
  };
  for (const def of catalogue) {
    out[def.key] = changeOf(side(current, def), side(previous, def));
  }
  return out;
}

/**
 * The aggregated comparison period of `period` (previous period or one year
 * earlier) from the same month records; null for "inception" or when the
 * comparison period has no data.
 */
export function fundComparison(
  months: readonly FundMonth[],
  period: Pick<Period, "grain" | "start">,
  mode: "previous" | "yearAgo",
  opts: { inceptionMonth?: MonthKey } = {},
): FundPeriod | null {
  const cp = comparisonPeriod(period, mode);
  if (cp === null) return null;
  const [p] = aggregate(
    months,
    cp.grain,
    { from: cp.start, to: cp.months[cp.months.length - 1] as MonthKey },
    opts,
  );
  return p?.hasData ? p : null;
}

/** As `fundComparison`, for one holder on the fund calendar. */
export function holderComparison(
  holderMonths: readonly HolderMonth[],
  fundMonths: readonly Pick<FundMonth, "month" | "inProgress">[],
  period: Pick<Period, "grain" | "start">,
  mode: "previous" | "yearAgo",
  opts: { inceptionMonth?: MonthKey } = {},
): HolderPeriod | null {
  const cp = comparisonPeriod(period, mode);
  if (cp === null) return null;
  const [p] = aggregateHolder(
    holderMonths,
    fundMonths,
    cp.grain,
    { from: cp.start, to: cp.months[cp.months.length - 1] as MonthKey },
    opts,
  );
  return p?.hasData ? p : null;
}

// ---------------------------------------------------------------------------
// Stored JSON (FinancialSnapshot.data / HolderFinancialSnapshot.data)

const zCents = z.number().int(); // safe integer (zod 4 int())
const zYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zMonth = z.string().regex(/^\d{4}-\d{2}-01$/);
const zUnits = z.string().regex(/^-?\d+\.\d{6}$/);

export const FundMonthJsonSchema = z.strictObject({
  schemaVersion: z.literal(FINANCIAL_SERIES_SCHEMA_VERSION),
  month: zMonth,
  asOf: zYmd,
  inProgress: z.boolean(),
  grossRevenue: zCents,
  otherIncome: zCents,
  assetSaleProceeds: zCents,
  insuranceProceeds: zCents,
  totalExpenses: zCents,
  operatingExpenses: zCents,
  capitalFundedExpenses: zCents,
  expensesByCategory: z
    .array(z.strictObject({ category: z.string().max(200), amount: zCents }))
    .max(200),
  managementFeeAccrued: zCents,
  managementFeePaid: zCents,
  managementFeeUnpaid: zCents,
  netOperatingIncome: zCents,
  reserveBalance: zCents,
  reservesByKind: z
    .array(z.strictObject({ kind: z.string().max(200), balance: zCents }))
    .max(200),
  minimumReserve: zCents,
  reservesEstablished: zCents,
  reservesReleased: zCents,
  availableCash: zCents,
  distributions: z.strictObject({
    preferredReturn: zCents,
    returnOfCapital: zCents,
    residualPreferred: zCents,
    residualCommon: zCents,
    gross: zCents,
  }),
  capitalReceived: zCents,
  paidInCapital: zCents,
  unreturnedCapital: zCents,
  preferredReturnAccruedToDate: zCents,
  preferredReturnPaidToDate: zCents,
  preferredReturnUnpaid: zCents,
  committed: zCents,
  uncalled: zCents,
  utilizationBps: z.number().int().min(0).max(10_000).nullable(),
  memberLoansOutstanding: zCents,
  orgExpenseCap: z.strictObject({ counted: zCents, limit: zCents }),
});
export type FundMonthJson = z.infer<typeof FundMonthJsonSchema>;

export const HolderMonthJsonSchema = z.strictObject({
  schemaVersion: z.literal(FINANCIAL_SERIES_SCHEMA_VERSION),
  holderId: z.string().min(1).max(64),
  month: zMonth,
  asOf: zYmd,
  inProgress: z.boolean(),
  contributions: zCents,
  credits: zCents,
  forfeited: zCents,
  preferredReturnAccrued: zCents,
  preferredReturnPaid: zCents,
  capitalReturned: zCents,
  residualPaid: zCents,
  grossDistributions: zCents,
  defaultOffsets: zCents,
  taxAdvanceOffsets: zCents,
  netPaid: zCents,
  paidIn: zCents,
  unreturnedCapital: zCents,
  preferredUnits: zUnits,
  commonUnits: zUnits,
  preferredPct: z.string().regex(/^-?\d+\.\d{4}$/),
  preferredReturnUnpaid: zCents,
  committed: zCents,
  uncalled: zCents,
  calledOutstanding: zCents,
});
export type HolderMonthJson = z.infer<typeof HolderMonthJsonSchema>;

/** bigint cents → JSON number; RangeError beyond ±Number.MAX_SAFE_INTEGER. */
function centsToJson(c: Cents): number {
  if (
    c > BigInt(Number.MAX_SAFE_INTEGER) ||
    c < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(`Cents value out of the safe integer range: ${c}`);
  }
  return Number(c);
}

/** Keys of FundMonth / HolderMonth whose bigint values are units, not cents. */
const UNIT_KEYS = new Set(["preferredUnits", "commonUnits"]);

function encode(value: unknown, key = ""): unknown {
  if (typeof value === "bigint") {
    return UNIT_KEYS.has(key)
      ? microUnitsToDecimalString(value)
      : centsToJson(value);
  }
  if (Array.isArray(value)) return value.map((v) => encode(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v, k);
    return out;
  }
  return value;
}

export function fundMonthToJson(m: FundMonth): FundMonthJson {
  return FundMonthJsonSchema.parse(encode(m));
}

export function holderMonthToJson(m: HolderMonth): HolderMonthJson {
  return HolderMonthJsonSchema.parse(encode(m));
}

/** Parses stored JSON (refuses another schema version or an unknown field). */
export function fundMonthFromJson(json: unknown): FundMonth {
  const j = FundMonthJsonSchema.parse(json);
  const b = (n: number) => BigInt(n);
  return {
    ...j,
    schemaVersion: FINANCIAL_SERIES_SCHEMA_VERSION,
    grossRevenue: b(j.grossRevenue),
    otherIncome: b(j.otherIncome),
    assetSaleProceeds: b(j.assetSaleProceeds),
    insuranceProceeds: b(j.insuranceProceeds),
    totalExpenses: b(j.totalExpenses),
    operatingExpenses: b(j.operatingExpenses),
    capitalFundedExpenses: b(j.capitalFundedExpenses),
    expensesByCategory: j.expensesByCategory.map((c) => ({
      category: c.category,
      amount: b(c.amount),
    })),
    managementFeeAccrued: b(j.managementFeeAccrued),
    managementFeePaid: b(j.managementFeePaid),
    managementFeeUnpaid: b(j.managementFeeUnpaid),
    netOperatingIncome: b(j.netOperatingIncome),
    reserveBalance: b(j.reserveBalance),
    reservesByKind: j.reservesByKind.map((k) => ({
      kind: k.kind,
      balance: b(k.balance),
    })),
    minimumReserve: b(j.minimumReserve),
    reservesEstablished: b(j.reservesEstablished),
    reservesReleased: b(j.reservesReleased),
    availableCash: b(j.availableCash),
    distributions: {
      preferredReturn: b(j.distributions.preferredReturn),
      returnOfCapital: b(j.distributions.returnOfCapital),
      residualPreferred: b(j.distributions.residualPreferred),
      residualCommon: b(j.distributions.residualCommon),
      gross: b(j.distributions.gross),
    },
    capitalReceived: b(j.capitalReceived),
    paidInCapital: b(j.paidInCapital),
    unreturnedCapital: b(j.unreturnedCapital),
    preferredReturnAccruedToDate: b(j.preferredReturnAccruedToDate),
    preferredReturnPaidToDate: b(j.preferredReturnPaidToDate),
    preferredReturnUnpaid: b(j.preferredReturnUnpaid),
    committed: b(j.committed),
    uncalled: b(j.uncalled),
    memberLoansOutstanding: b(j.memberLoansOutstanding),
    orgExpenseCap: {
      counted: b(j.orgExpenseCap.counted),
      limit: b(j.orgExpenseCap.limit),
    },
  };
}

export function holderMonthFromJson(json: unknown): HolderMonth {
  const j = HolderMonthJsonSchema.parse(json);
  const b = (n: number) => BigInt(n);
  return {
    ...j,
    schemaVersion: FINANCIAL_SERIES_SCHEMA_VERSION,
    contributions: b(j.contributions),
    credits: b(j.credits),
    forfeited: b(j.forfeited),
    preferredReturnAccrued: b(j.preferredReturnAccrued),
    preferredReturnPaid: b(j.preferredReturnPaid),
    capitalReturned: b(j.capitalReturned),
    residualPaid: b(j.residualPaid),
    grossDistributions: b(j.grossDistributions),
    defaultOffsets: b(j.defaultOffsets),
    taxAdvanceOffsets: b(j.taxAdvanceOffsets),
    netPaid: b(j.netPaid),
    paidIn: b(j.paidIn),
    unreturnedCapital: b(j.unreturnedCapital),
    preferredUnits: microUnitsFromDecimal(j.preferredUnits),
    commonUnits: microUnitsFromDecimal(j.commonUnits),
    preferredReturnUnpaid: b(j.preferredReturnUnpaid),
    committed: b(j.committed),
    uncalled: b(j.uncalled),
    calledOutstanding: b(j.calledOutstanding),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort(byText)) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** JSON with sorted keys: the input of `FinancialSnapshot.dataHash` (SHA-256 is the caller's). */
export function canonicalJson(value: FundMonthJson | HolderMonthJson): string {
  return JSON.stringify(canonical(value));
}

// ---------------------------------------------------------------------------
// Drift (5.9 `financialDashboard.status`)

function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    // breakdown lists: keyed by their label (category / kind)
    const keyOf = (r: unknown): string => {
      const o = r as Record<string, unknown>;
      return String(o.category ?? o.kind ?? JSON.stringify(o));
    };
    const am = new Map(a.map((r) => [keyOf(r), r]));
    const bm = new Map(b.map((r) => [keyOf(r), r]));
    const keys = [...new Set([...am.keys(), ...bm.keys()])].sort(byText);
    for (const k of keys) {
      const ar = am.get(k);
      const br = bm.get(k);
      if (ar === undefined || br === undefined) out.push(`${path}.${k}`);
      else diffPaths(ar, br, `${path}.${k}`, out);
    }
    return;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object"
  ) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(
      byText,
    );
    for (const k of keys) {
      diffPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path === "" ? k : `${path}.${k}`,
        out,
      );
    }
    return;
  }
  if (a !== b) out.push(path);
}

/**
 * The fields that differ between two records of the same month (a stored
 * snapshot and the ledger today), as dotted paths ("grossRevenue",
 * "distributions.gross", "expensesByCategory.COLOCATION"). `asOf` and
 * `inProgress` are not compared. Empty when equal.
 */
export function compareFundMonths(a: FundMonth, b: FundMonth): string[] {
  if (a.month !== b.month) {
    throw new LlcMathError("MONTH_MISMATCH", `${a.month} vs ${b.month}`);
  }
  const out: string[] = [];
  diffPaths(
    { ...fundMonthToJson(a), asOf: null, inProgress: null },
    { ...fundMonthToJson(b), asOf: null, inProgress: null },
    "",
    out,
  );
  return out;
}

/** As `compareFundMonths`, for one holder's records of the same month. */
export function compareHolderMonths(a: HolderMonth, b: HolderMonth): string[] {
  if (a.month !== b.month || a.holderId !== b.holderId) {
    throw new LlcMathError("MONTH_MISMATCH", "Different holder or month");
  }
  const out: string[] = [];
  diffPaths(
    { ...holderMonthToJson(a), asOf: null, inProgress: null },
    { ...holderMonthToJson(b), asOf: null, inProgress: null },
    "",
    out,
  );
  return out;
}
