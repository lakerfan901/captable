// The series of every dashboard chart (04-investor-portal.md 5.9 "Charts",
// F1–F8, M1–M2), taken from the P12 metric catalogue by key: the label, the
// unit, the rule and the getter are the catalogue's, so the charts cannot
// invent a figure. Pure: relative imports only, tested.

import {
  FUND_METRICS,
  type FundPeriodValues,
  HOLDER_METRICS,
  type HolderPeriodValues,
  type MetricDef,
} from "../../lib/llc/financial-series";
import { humanizeCategory } from "../../lib/xlsx/report-workbook";
import {
  type BreakdownSeries,
  breakdownSeries,
  breakdownValue,
  type ChartSlot,
  type ExtraSpec,
  type SeriesMark,
  type SeriesSpec,
} from "../charts/chart-model";

function metric<V>(
  catalogue: readonly MetricDef<V>[],
  key: string,
): MetricDef<V> {
  const def = catalogue.find((m) => m.key === key);
  if (!def) throw new Error(`Unknown metric ${key}`);
  return def;
}

function series<V>(
  catalogue: readonly MetricDef<V>[],
  key: string,
  mark: SeriesMark,
  slot: ChartSlot,
  opts: { label?: string; stack?: string } = {},
): SeriesSpec<V> {
  const def = metric(catalogue, key);
  return {
    key: def.key,
    label: opts.label ?? def.label,
    mark,
    unit: def.unit,
    slot,
    stack: opts.stack,
    rule: def.rule,
    get: def.get,
  };
}

function extra<V>(
  catalogue: readonly MetricDef<V>[],
  key: string,
  label?: string,
): ExtraSpec<V> {
  const def = metric(catalogue, key);
  return {
    key: def.key,
    label: label ?? def.label,
    unit: def.unit,
    get: def.get,
  };
}

const F = FUND_METRICS;
const H = HOLDER_METRICS;

export interface ChartSpec<V> {
  series: SeriesSpec<V>[];
  extras: ExtraSpec<V>[];
}

/** F1: Gross Revenue, operating expenses, Management Fee (bars); net operating income (line). */
export const REVENUE_SPEC: ChartSpec<FundPeriodValues> = {
  series: [
    series(F, "grossRevenue", "bar", 1),
    series(F, "operatingExpenses", "bar", 2),
    series(F, "managementFeeAccrued", "bar", 3, { label: "Management Fee" }),
    series(F, "netOperatingIncome", "line", 4, {
      label: "Net operating income",
    }),
  ],
  extras: [],
};

/** F4: distributions by tier, stacked; cumulative distributions in the tooltip and table. */
export const DISTRIBUTIONS_SPEC: ChartSpec<FundPeriodValues> = {
  series: [
    series(F, "distributions.preferredReturn", "bar", 1, {
      label: "Preferred return",
      stack: "d",
    }),
    series(F, "distributions.returnOfCapital", "bar", 2, {
      label: "Return of capital",
      stack: "d",
    }),
    series(F, "distributions.residualPreferred", "bar", 3, {
      label: "Residual (Preferred)",
      stack: "d",
    }),
    series(F, "distributions.residualCommon", "bar", 4, {
      label: "Residual (Common)",
      stack: "d",
    }),
  ],
  extras: [extra(F, "cumulativeDistributions")],
};

/** F5: paid-in and unreturned capital and cumulative distributions to the Preferred class (lines); DPI in the tooltip and table. */
export const CAPITAL_SPEC: ChartSpec<FundPeriodValues> = {
  series: [
    series(F, "paidInCapital", "line", 1),
    series(F, "unreturnedCapital", "line", 2),
    series(F, "cumulativeDistributionsToPreferred", "line", 3),
  ],
  extras: [extra(F, "dpiBps")],
};

/** F6: preferred return accrued and paid to date (areas); unpaid balance (line). */
export const PREFERRED_RETURN_SPEC: ChartSpec<FundPeriodValues> = {
  series: [
    series(F, "preferredReturnAccruedToDate", "area", 1, {
      label: "Accrued to date",
    }),
    series(F, "preferredReturnPaidToDate", "area", 2, {
      label: "Paid to date",
    }),
    series(F, "preferredReturnUnpaid", "line", 3, {
      label: "Unpaid balance",
    }),
  ],
  extras: [],
};

/** F8: utilization as reported by the Manager. */
export const UTILIZATION_SPEC: ChartSpec<FundPeriodValues> = {
  series: [series(F, "utilizationBps", "line", 1, { label: "Utilization" })],
  extras: [],
};

/** M1: my distributions by tier (stacked); my cumulative distributions and offsets in the tooltip and table. */
export const MY_DISTRIBUTIONS_SPEC: ChartSpec<HolderPeriodValues> = {
  series: [
    series(H, "preferredReturnPaid", "bar", 1, {
      label: "Preferred return",
      stack: "m",
    }),
    series(H, "capitalReturned", "bar", 2, {
      label: "Return of capital",
      stack: "m",
    }),
    series(H, "residualPaid", "bar", 3, { label: "Residual", stack: "m" }),
  ],
  extras: [
    extra(H, "defaultOffsets"),
    extra(H, "taxAdvanceOffsets"),
    extra(H, "netPaid"),
    extra(H, "cumulativeGrossDistributions"),
  ],
};

/** M2: my paid-in, unreturned capital and unpaid preferred return (lines); my DPI in the tooltip and table. */
export const MY_CAPITAL_SPEC: ChartSpec<HolderPeriodValues> = {
  series: [
    series(H, "paidIn", "line", 1, { label: "Paid in" }),
    series(H, "unreturnedCapital", "line", 2),
    series(H, "preferredReturnUnpaid", "line", 3),
  ],
  extras: [extra(H, "dpiBps")],
};

// ---------------------------------------------------------------------------
// Breakdowns (F2, F7): one series per label, coloured by identity

/** Totals of each expense category over every period given (the whole series, not the window). */
export function expenseTotals(
  values: readonly (FundPeriodValues | null)[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const v of values) {
    for (const c of v?.expensesByCategory ?? []) {
      out.set(c.category, (out.get(c.category) ?? 0n) + c.amount);
    }
  }
  return out;
}

/** Peak balance of each reserve kind over every period given. */
export function reserveTotals(
  values: readonly (FundPeriodValues | null)[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const v of values) {
    for (const k of v?.reservesByKind ?? []) {
      const prev = out.get(k.kind) ?? 0n;
      const abs = k.balance < 0n ? -k.balance : k.balance;
      // biome-ignore lint/complexity/useMathMinMax: bigint values (Math.max takes numbers)
      out.set(k.kind, abs > prev ? abs : prev);
    }
  }
  return out;
}

/** F2: one stacked bar series per expense category (folded to "Other" past seven). */
export function expensesSpec(
  breakdown: readonly BreakdownSeries[],
): ChartSpec<FundPeriodValues> {
  return {
    series: breakdown.map((b) => ({
      key: b.key,
      label: b.label,
      mark: "bar",
      unit: "cents",
      slot: b.slot,
      stack: "e",
      rule: "sum",
      get: (v) =>
        breakdownValue(
          v.expensesByCategory.map((c) => ({
            label: c.category,
            amount: c.amount,
          })),
          b.members,
        ),
    })),
    extras: [],
  };
}

export const MINIMUM_RESERVE_KEY = "minimumReserve";

/** F7: reserve balance by kind (stacked areas) and the minimum required (line). */
export function reservesSpec(
  breakdown: readonly BreakdownSeries[],
): ChartSpec<FundPeriodValues> {
  const kinds: SeriesSpec<FundPeriodValues>[] = breakdown.map((b) => ({
    key: b.key,
    label: b.label,
    mark: "area",
    unit: "cents",
    slot: b.slot,
    stack: "r",
    rule: "end",
    get: (v) =>
      breakdownValue(
        v.reservesByKind.map((k) => ({ label: k.kind, amount: k.balance })),
        b.members,
      ),
  }));
  // the minimum takes the next free slot (never one of a kind's)
  const used = new Set(breakdown.map((b) => b.slot));
  const free =
    ([1, 2, 3, 4, 5, 6, 7, 8] as const).find((s) => !used.has(s)) ?? 8;
  return {
    series: [
      ...kinds,
      series(F, MINIMUM_RESERVE_KEY, "line", free, {
        label: "Minimum required",
      }),
    ],
    extras: [extra(F, "reserveBalance", "Total reserve balance")],
  };
}

/** Breakdown series of expense categories, humanised as in the report. */
export function expenseBreakdown(
  values: readonly (FundPeriodValues | null)[],
): BreakdownSeries[] {
  return breakdownSeries(expenseTotals(values), humanizeCategory);
}

/**
 * Breakdown series of reserve kinds. One slot is kept back for the minimum
 * line, so at most seven kind series (six and "Other").
 */
export function reserveBreakdown(
  values: readonly (FundPeriodValues | null)[],
): BreakdownSeries[] {
  return breakdownSeries(reserveTotals(values), humanizeCategory, 7);
}

/** F8 is shown only when at least one month has a utilization value. */
export function hasUtilization(
  months: readonly { utilizationBps: number | null }[],
): boolean {
  return months.some((m) => m.utilizationBps !== null);
}

export { humanizeCategory };
