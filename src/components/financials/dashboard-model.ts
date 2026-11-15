// KPI tiles and the cash-flow waterfall of the financial dashboard
// (04-investor-portal.md 5.9 "KPI tiles", F3). Pure: relative imports only,
// tested. The values come from aggregated periods; this module only picks,
// compares and formats them.

import type { Change } from "../../lib/llc/financial-periods";
import {
  type AggregatedPeriod,
  comparePeriodValues,
  FUND_METRICS,
  type FundPeriodValues,
  HOLDER_METRICS,
  type HolderPeriodValues,
  type MetricDef,
} from "../../lib/llc/financial-series";
import {
  formatChangeAmount,
  formatUnits,
  formatValue,
  plotNumber,
  type ValueUnit,
} from "../charts/chart-format";
import {
  type ChartSlot,
  type TableModel,
  type TooltipModel,
  type WaterfallKind,
  type WaterfallStep,
  waterfall,
} from "../charts/chart-model";

/** Which direction of a change is good for the reader. */
export type Direction = "up" | "down" | "neutral";

export interface TileDef<V> {
  key: string;
  label: string;
  unit: ValueUnit;
  /** flows (summed over the period) compare in percent, balances in amount */
  flow: boolean;
  good: Direction;
  get: (v: V) => bigint | number | null;
  /** a line under the value, from the same period */
  sub?: (v: V) => string | null;
}

export interface DeltaView {
  /** "up" / "down" / "flat" */
  dir: "up" | "down" | "flat";
  /** good / bad / neutral colouring (always with the arrow and the words) */
  tone: "good" | "bad" | "neutral";
  /** "Up 12.3%", "Down $1,200.00", "No change" */
  text: string;
  /** "vs Q1 2027" */
  against: string;
}

export interface TileView {
  key: string;
  label: string;
  value: string;
  sub: string | null;
  /** null: no comparison shown */
  delta: DeltaView | null;
  /** why there is no delta, when there should have been one ("Not compared: Q4 2027 is not complete") */
  deltaNote: string | null;
  /** sparkline points (oldest first), whole periods only for flows */
  spark: number[];
}

function fromCatalogue<V>(
  catalogue: readonly MetricDef<V>[],
  key: string,
  opts: { label?: string; good: Direction; sub?: (v: V) => string | null },
): TileDef<V> {
  const def = catalogue.find((m) => m.key === key);
  if (!def) throw new Error(`Unknown metric ${key}`);
  return {
    key,
    label: opts.label ?? def.label,
    unit: def.unit,
    flow: def.rule === "sum" || def.rule === "mean",
    good: opts.good,
    get: def.get,
    sub: opts.sub,
  };
}

const F = FUND_METRICS;
const H = HOLDER_METRICS;
const money = (v: bigint) => formatValue("cents", v);

/** The fund tiles of 5.9 (utilization is dropped by the caller when no month has a value). */
export const FUND_TILES: TileDef<FundPeriodValues>[] = [
  fromCatalogue(F, "grossRevenue", { good: "up" }),
  fromCatalogue(F, "operatingExpenses", { good: "down" }),
  fromCatalogue(F, "netOperatingIncome", {
    label: "Net operating income",
    good: "up",
    sub: () => "Before reserves and distributions",
  }),
  fromCatalogue(F, "managementFeeAccrued", {
    label: "Management Fee",
    good: "neutral",
    sub: (v) => `${money(v.managementFeePaid)} paid in the period`,
  }),
  fromCatalogue(F, "utilizationBps", {
    label: "Utilization",
    good: "up",
    sub: () => "Average of the months reported by the Manager",
  }),
  fromCatalogue(F, "distributions.gross", { good: "up" }),
  fromCatalogue(F, "cumulativeDistributions", {
    good: "up",
    sub: () => "Since inception",
  }),
  fromCatalogue(F, "availableCash", {
    good: "neutral",
    sub: () => "At the end of the period",
  }),
  fromCatalogue(F, "reserveBalance", {
    good: "neutral",
    sub: (v) => `Minimum required ${money(v.minimumReserve)}`,
  }),
  fromCatalogue(F, "paidInCapital", {
    good: "neutral",
    sub: (v) => `${money(v.committed)} committed`,
  }),
  fromCatalogue(F, "dpiBps", {
    good: "up",
    sub: () => "Distributions to the class ÷ paid-in capital",
  }),
];

/** The holder's own tiles of 5.9 ("Mine"). */
export const HOLDER_TILES: TileDef<HolderPeriodValues>[] = [
  fromCatalogue(H, "committed", {
    good: "neutral",
    sub: (v) => `${money(v.uncalled)} not yet called`,
  }),
  fromCatalogue(H, "paidIn", {
    good: "neutral",
    sub: () => "At the end of the period",
  }),
  fromCatalogue(H, "grossDistributions", {
    good: "up",
    sub: (v) => `${money(v.cumulativeGrossDistributions)} to date`,
  }),
  fromCatalogue(H, "capitalReturned", {
    label: "Capital returned",
    good: "up",
    sub: () => "In the period",
  }),
  fromCatalogue(H, "unreturnedCapital", {
    good: "neutral",
    sub: () => "Paid in, not yet returned",
  }),
  fromCatalogue(H, "preferredReturnUnpaid", {
    good: "down",
    sub: (v) => `${money(v.preferredReturnAccrued)} accrued in the period`,
  }),
  fromCatalogue(H, "dpiBps", {
    good: "up",
    sub: () => "Your distributions ÷ your paid-in capital",
  }),
];

/** The units tile: preferred and common units at the period end, and the share of the Preferred class. */
export function unitsTile(v: HolderPeriodValues): TileView {
  const lines: string[] = [];
  if (v.preferredUnits !== 0n) {
    lines.push(`Preferred units · ${v.preferredPct}% of the class`);
  }
  if (v.commonUnits !== 0n)
    lines.push(`${formatUnits(v.commonUnits)} Common units`);
  return {
    key: "units",
    label: "Units",
    value: formatUnits(
      v.preferredUnits !== 0n ? v.preferredUnits : v.commonUnits,
    ),
    sub: lines.length ? lines.join(" · ") : "No units at the end of the period",
    delta: null,
    deltaNote: null,
    spark: [],
  };
}

function deltaOf(
  tile: TileDef<unknown>,
  change: Change,
  against: string,
): DeltaView | null {
  if (change.amount === null) return null;
  const dir = change.amount > 0n ? "up" : change.amount < 0n ? "down" : "flat";
  if (dir === "flat")
    return { dir, tone: "neutral", text: "No change", against };
  const tone =
    tile.good === "neutral" ? "neutral" : tile.good === dir ? "good" : "bad";
  if (change.status === "PREVIOUS_ZERO" && tile.flow && tile.unit === "cents") {
    return {
      dir,
      tone,
      text: `${dir === "up" ? "Up" : "Down"} ${formatChangeAmount(tile.unit, change.amount, null, false)}`,
      against: `${against} (none then)`,
    };
  }
  const size = formatChangeAmount(
    tile.unit,
    change.amount,
    change.pctBps,
    tile.flow,
  );
  return {
    dir,
    tone,
    text: `${dir === "up" ? "Up" : "Down"} ${size}`,
    against,
  };
}

/**
 * The tiles of one period: value, sub-line, the change against the
 * comparison period (absent when either side is partial, with the reason),
 * and a sparkline over the trend periods.
 */
export function tileViews<V>(
  defs: readonly TileDef<V>[],
  current: AggregatedPeriod<V>,
  comparison: AggregatedPeriod<V> | null,
  comparisonLabel: string | null,
  trend: readonly AggregatedPeriod<V>[],
): TileView[] {
  const changes = comparePeriodValues(
    defs.map((d) => ({
      key: d.key,
      label: d.label,
      unit: "cents" as const,
      rule: "sum" as const,
      portal: true,
      get: d.get,
    })),
    current,
    comparison,
  );
  return defs.map((d) => {
    const v = current.values;
    const raw = v === null ? null : d.get(v);
    const change = changes[d.key] as Change;
    let delta: DeltaView | null = null;
    let deltaNote: string | null = null;
    if (comparisonLabel !== null) {
      if (change.status === "PARTIAL") {
        deltaNote = current.partial
          ? "Period not complete: not compared"
          : `Not compared: ${comparisonLabel} is not complete`;
      } else if (change.status === "NOT_AVAILABLE") {
        deltaNote = raw === null ? null : `No figures for ${comparisonLabel}`;
      } else {
        delta = deltaOf(d as TileDef<unknown>, change, `vs ${comparisonLabel}`);
      }
    }
    const spark = trend
      .filter((p) => p.values !== null && !(d.flow && p.partial))
      .map((p) => plotNumber(d.get(p.values as V)))
      .filter((n): n is number => n !== null);
    return {
      key: d.key,
      label: d.label,
      value: formatValue(d.unit, raw),
      sub: v === null || !d.sub ? null : d.sub(v),
      delta,
      deltaNote,
      spark,
    };
  });
}

// ---------------------------------------------------------------------------
// F3: cash flow of one period

export const CASH_FLOW_OTHER_LABEL = "Other movements";
export const CASH_FLOW_CHANGE_LABEL = "Change in Available Cash";

/**
 * F3 steps: revenue → other income → asset-sale and insurance proceeds →
 * operating expenses → Management Fee paid → reserves set aside / released →
 * distributions, then "Other movements" (whatever the listed lines do not
 * explain: spending paid from capital, member loans, timing) and the change
 * in Available Cash from the end of the previous period (`opening`).
 */
export function cashFlowSteps(
  v: FundPeriodValues,
  opening: bigint,
): WaterfallStep[] {
  return waterfall(
    [
      { key: "grossRevenue", label: "Gross Revenue", amount: v.grossRevenue },
      { key: "otherIncome", label: "Other income", amount: v.otherIncome },
      {
        key: "proceeds",
        label: "Asset-sale and insurance proceeds",
        amount: v.assetSaleProceeds + v.insuranceProceeds,
      },
      {
        key: "operatingExpenses",
        label: "Operating expenses",
        amount: -v.operatingExpenses,
      },
      {
        key: "managementFeePaid",
        label: "Management Fee paid",
        amount: -v.managementFeePaid,
      },
      {
        key: "reservesEstablished",
        label: "Reserves set aside",
        amount: -v.reservesEstablished,
      },
      {
        key: "reservesReleased",
        label: "Reserves released",
        amount: v.reservesReleased,
      },
      {
        key: "distributions",
        label: "Distributions",
        amount: -v.distributions.gross,
      },
    ].filter((s) => s.amount !== 0n),
    v.availableCash - opening,
    { other: CASH_FLOW_OTHER_LABEL, change: CASH_FLOW_CHANGE_LABEL },
  );
}

export const CASH_FLOW_KIND_SLOT: Record<WaterfallKind, ChartSlot> = {
  in: 1,
  out: 2,
  total: 7,
};
export const CASH_FLOW_KIND_LABEL: Record<WaterfallKind, string> = {
  in: "Money in",
  out: "Money out",
  total: "Change in Available Cash",
};

/** F3's tooltip of each step and its table, from the same strings. */
export function cashFlowView(
  steps: readonly WaterfallStep[],
  periodLabel: string,
): { tooltips: TooltipModel[]; table: TableModel } {
  const tooltips: TooltipModel[] = steps.map((s) => ({
    title: s.label,
    note: null,
    lines: [
      {
        key: "amount",
        label: s.kind === "total" ? periodLabel : CASH_FLOW_KIND_LABEL[s.kind],
        value: formatValue("cents", s.amount),
        slot: CASH_FLOW_KIND_SLOT[s.kind],
      },
    ],
    total: null,
    extras:
      s.kind === "total"
        ? []
        : [
            {
              key: "run",
              label: "Running total",
              value: formatValue("cents", s.to),
              slot: null,
            },
          ],
  }));
  return {
    tooltips,
    table: {
      columns: [
        { key: "amount", label: "Amount", slot: null },
        { key: "run", label: "Running total", slot: null },
      ],
      rows: steps.map((s, i) => ({
        key: s.key,
        label: s.label,
        cells: [
          tooltips[i]?.lines[0]?.value ?? "—",
          tooltips[i]?.extras[0]?.value ?? "",
        ],
      })),
      totals: null,
    },
  };
}
