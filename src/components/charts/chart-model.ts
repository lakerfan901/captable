// View model of the chart kit (04-investor-portal.md 5.9 "Charts", P14).
// Pure: relative imports only, tested.
//
// A chart is a list of SERIES over a list of ROWS. A row is one aggregated
// period (`aggregate` / `aggregateHolder` output) or one step of a waterfall.
// Each row keeps the RAW value of every series (bigint cents, basis points or
// null) and the number the chart plots. The tooltip and the table format the
// same raw value with the same function, so they cannot disagree.

import {
  type Grain,
  type MonthKey,
  periodLabel,
} from "../../lib/llc/financial-periods";
import type {
  AggregatedPeriod,
  MetricRule,
} from "../../lib/llc/financial-series";
import {
  formatValue,
  type NiceScale,
  niceScale,
  plotNumber,
  type RawValue,
  type ValueUnit,
} from "./chart-format";

/** The eight colour tokens `--chart-1` … `--chart-8` (globals.css). */
export const CHART_SLOTS = 8;
export type ChartSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const slotColor = (slot: ChartSlot): string => `var(--chart-${slot})`;

export type SeriesMark = "bar" | "line" | "area";

export interface SeriesSpec<V> {
  /** unique within the chart; the catalogue key where one exists */
  key: string;
  label: string;
  mark: SeriesMark;
  unit: ValueUnit;
  slot: ChartSlot;
  /** series with the same stack id are stacked */
  stack?: string;
  /** "sum" series get a total in the table's totals row */
  rule: MetricRule;
  get: (v: V) => RawValue;
}

/** A figure shown in the tooltip and the table only (never plotted, never a second axis). */
export interface ExtraSpec<V> {
  key: string;
  label: string;
  unit: ValueUnit;
  get: (v: V) => RawValue;
}

export interface ChartRow {
  key: string;
  /** full label: "Q2 2027", "Q4 2027 to date" */
  label: string;
  /** axis label: "Q2 ’27", "Jan ’27", "Feb" */
  short: string;
  grain: Grain | "step";
  hasData: boolean;
  partial: boolean;
  inProgress: boolean;
  /** why the period is partial, for the tooltip ("2 of 3 months so far"); null when whole */
  partialNote: string | null;
  raw: Record<string, RawValue>;
  plot: Record<string, number | null>;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Axis label of a period key: "Q2 ’27", "2027", "Jan ’27" (January) or "Feb". */
export function shortPeriodLabel(key: string): string {
  if (key === "inception") return "All";
  let m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) {
    const month = MONTHS[Number(m[2]) - 1] ?? "";
    return m[2] === "01" ? `${month} ’${m[1]?.slice(2)}` : month;
  }
  m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (m) return `Q${m[2]} ’${m[1]?.slice(2)}`;
  return key;
}

/**
 * How a partial period is described. Missing months only at the end: "to
 * date"; only at the start (before inception): "from {month}"; otherwise
 * "{n} of {m} months". The month in progress: "in progress".
 */
export function partialOf(
  p: Pick<
    AggregatedPeriod<unknown>,
    "months" | "rangeMonths" | "presentMonths" | "partial" | "inProgress"
  >,
): { suffix: string; note: string } | null {
  if (!p.partial) return null;
  if (p.presentMonths.length === 0) {
    return { suffix: "(no figures)", note: "No figures for this period" };
  }
  if (p.inProgress) {
    return {
      suffix: "to date",
      note: "Includes the month in progress; its figures are not final",
    };
  }
  const n = p.presentMonths.length;
  const total = p.months.length;
  const of = `${n} of ${total} months`;
  // a month inside the range without a record is a gap; months outside the
  // range were cut (before inception, after the last month with figures)
  const gaps = p.rangeMonths.some((m) => !p.presentMonths.includes(m));
  const idx = p.presentMonths.map((m) => p.months.indexOf(m));
  const first = idx[0] ?? 0;
  const lastIdx = idx[idx.length - 1] ?? 0;
  if (!gaps && first === 0) {
    return { suffix: "to date", note: `${of} so far` };
  }
  if (!gaps && lastIdx === total - 1) {
    const m = p.presentMonths[0] as MonthKey;
    const name = MONTHS[Number(m.slice(5, 7)) - 1] ?? "";
    return { suffix: `from ${name}`, note: `${of}: starts in ${name}` };
  }
  return { suffix: `(${of})`, note: `${of} have figures` };
}

/** Full label of an aggregated period, with its partial suffix. */
export function periodRowLabel(
  p: Pick<
    AggregatedPeriod<unknown>,
    | "key"
    | "months"
    | "rangeMonths"
    | "presentMonths"
    | "partial"
    | "inProgress"
  >,
): string {
  const base = periodLabel(p.key);
  const part = partialOf(p);
  return part ? `${base} ${part.suffix}` : base;
}

/** Rows of a period chart: one per aggregated period, raw and plotted values per series and extra. */
export function buildPeriodRows<V>(
  periods: readonly AggregatedPeriod<V>[],
  series: readonly SeriesSpec<V>[],
  extras: readonly ExtraSpec<V>[] = [],
): ChartRow[] {
  return periods.map((p) => {
    const raw: Record<string, RawValue> = {};
    const plot: Record<string, number | null> = {};
    for (const s of [...series, ...extras]) {
      const v = p.values === null ? null : s.get(p.values);
      raw[s.key] = v;
      plot[s.key] = plotNumber(v);
    }
    const part = partialOf(p);
    return {
      key: p.key,
      label: periodRowLabel(p),
      short: shortPeriodLabel(p.key),
      grain: p.grain,
      hasData: p.hasData,
      partial: p.partial,
      inProgress: p.inProgress,
      partialNote: part?.note ?? null,
      raw,
      plot,
    };
  });
}

// ---------------------------------------------------------------------------
// Visible series (legend toggles)

/** The series shown: all but the hidden keys, in their fixed order. */
export function visibleSeries<S extends { key: string }>(
  series: readonly S[],
  hidden: ReadonlySet<string>,
): S[] {
  return series.filter((s) => !hidden.has(s.key));
}

/** Toggles one key; never hides the last visible series. */
export function toggleHidden(
  hidden: ReadonlySet<string>,
  key: string,
  allKeys: readonly string[],
): Set<string> {
  const next = new Set(hidden);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  next.add(key);
  if (allKeys.every((k) => next.has(k))) return new Set(hidden);
  return next;
}

// ---------------------------------------------------------------------------
// Tooltip and table: the same strings

export interface TooltipLine {
  key: string;
  label: string;
  value: string;
  slot: ChartSlot | null;
}

export interface TooltipModel {
  title: string;
  note: string | null;
  lines: TooltipLine[];
  /** the stacked total of the visible stacked series, when the chart stacks */
  total: TooltipLine | null;
  extras: TooltipLine[];
}

function stackTotal<V>(row: ChartRow, series: readonly SeriesSpec<V>[]) {
  const stacked = series.filter((s) => s.stack !== undefined);
  if (stacked.length < 2) return null;
  let sum = 0n;
  let any = false;
  for (const s of stacked) {
    const v = row.raw[s.key] ?? null;
    if (v === null) continue;
    any = true;
    sum += typeof v === "bigint" ? v : BigInt(v);
  }
  return any ? sum : null;
}

/** The tooltip of one row, for the visible series. */
export function tooltipModel<V>(
  row: ChartRow,
  series: readonly SeriesSpec<V>[],
  extras: readonly ExtraSpec<V>[] = [],
): TooltipModel {
  const lines = series.map((s) => ({
    key: s.key,
    label: s.label,
    value: formatValue(s.unit, row.raw[s.key] ?? null),
    slot: s.slot,
  }));
  const total = stackTotal(row, series);
  const unit = series.find((s) => s.stack !== undefined)?.unit ?? "cents";
  return {
    title: row.label,
    note: row.hasData ? row.partialNote : "No figures for this period",
    lines,
    total:
      total === null
        ? null
        : {
            key: "__total",
            label: "Total",
            value: formatValue(unit, total),
            slot: null,
          },
    extras: extras.map((x) => ({
      key: x.key,
      label: x.label,
      value: formatValue(x.unit, row.raw[x.key] ?? null),
      slot: null,
    })),
  };
}

/** One sentence for a screen reader: the same values as the tooltip. */
export function tooltipSentence(t: TooltipModel): string {
  const parts = [...t.lines, ...(t.total ? [t.total] : []), ...t.extras].map(
    (l) => `${l.label} ${l.value}`,
  );
  return `${t.title}${t.note ? ` (${t.note})` : ""}: ${parts.join(", ")}`;
}

export interface TableColumn {
  key: string;
  label: string;
  slot: ChartSlot | null;
}

export interface TableModel {
  columns: TableColumn[];
  rows: { key: string; label: string; cells: string[] }[];
  /** totals of the "sum" series over the rows; null when the chart has none */
  totals: string[] | null;
}

/**
 * The table twin of a chart: the same rows, every series (hidden ones too:
 * the table is the complete record), the stacked total and the extras. The
 * totals row sums the "sum" series and leaves end-of-period values blank.
 */
export function tableModel<V>(
  rows: readonly ChartRow[],
  series: readonly SeriesSpec<V>[],
  extras: readonly ExtraSpec<V>[] = [],
): TableModel {
  const stacked = series.filter((s) => s.stack !== undefined).length >= 2;
  const columns: TableColumn[] = [
    ...series.map((s) => ({ key: s.key, label: s.label, slot: s.slot })),
    ...(stacked ? [{ key: "__total", label: "Total", slot: null }] : []),
    ...extras.map((x) => ({ key: x.key, label: x.label, slot: null })),
  ];
  const body = rows.map((r) => {
    const t = tooltipModel(r, series, extras);
    return {
      key: r.key,
      label: r.label,
      cells: [
        ...t.lines.map((l) => l.value),
        ...(stacked ? [t.total?.value ?? "—"] : []),
        ...t.extras.map((l) => l.value),
      ],
    };
  });
  const summed = series.filter((s) => s.rule === "sum");
  let totals: string[] | null = null;
  if (summed.length > 0 && rows.length > 1) {
    const sumOf = (key: string): bigint | null => {
      let acc = 0n;
      let any = false;
      for (const r of rows) {
        const v = r.raw[key] ?? null;
        if (v === null) continue;
        any = true;
        acc += typeof v === "bigint" ? v : BigInt(v);
      }
      return any ? acc : null;
    };
    const cells = series.map((s) =>
      s.rule === "sum" ? formatValue(s.unit, sumOf(s.key)) : "",
    );
    if (stacked) {
      const all = series
        .filter((s) => s.stack !== undefined && s.rule === "sum")
        .map((s) => sumOf(s.key))
        .filter((v): v is bigint => v !== null);
      const unit = series.find((s) => s.stack !== undefined)?.unit ?? "cents";
      cells.push(
        all.length
          ? formatValue(
              unit,
              all.reduce((a, b) => a + b, 0n),
            )
          : "",
      );
    }
    totals = [...cells, ...extras.map(() => "")];
  }
  return { columns, rows: body, totals };
}

// ---------------------------------------------------------------------------
// Stacked bars: which segment is the cap (rounded end) and which carry the gap

export interface StackRole {
  /** the outermost segment on its side of zero: gets the 4px rounded end */
  cap: boolean;
  /** not the first segment from the baseline on its side: gets the 2px surface gap */
  gap: boolean;
}

/**
 * For each row and visible stacked series: the cap and gap roles. Positive
 * values stack upwards, negative ones downwards, each side separately (as
 * Recharts' `stackOffset="sign"` draws them). Zero and null draw nothing.
 */
export function stackRoles(
  rows: readonly ChartRow[],
  stacked: readonly { key: string }[],
): Map<string, Record<string, StackRole>> {
  const out = new Map<string, Record<string, StackRole>>();
  for (const r of rows) {
    const roles: Record<string, StackRole> = {};
    for (const sign of [1, -1]) {
      const keys = stacked
        .map((s) => s.key)
        .filter((k) => {
          const v = r.plot[k] ?? null;
          return v !== null && v !== 0 && Math.sign(v) === sign;
        });
      keys.forEach((k, i) => {
        roles[k] = { cap: i === keys.length - 1, gap: i > 0 };
      });
    }
    out.set(r.key, roles);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value axis and period labels

/**
 * The value axis of a chart: through zero, covering every visible value; a
 * stack counts by its positive and negative sums (as `stackOffset="sign"`
 * draws it); a fixed top (utilization: 0–100%) is used as given.
 */
export function valueScale(
  rows: readonly ChartRow[],
  shown: readonly Pick<SeriesSpec<unknown>, "key" | "stack" | "mark">[],
  fixedMax?: number,
): NiceScale {
  if (fixedMax !== undefined) {
    return {
      min: 0,
      max: fixedMax,
      ticks: [0, 1, 2, 3, 4].map((i) => (fixedMax * i) / 4),
    };
  }
  const stacked = shown.filter(
    (s) => s.stack !== undefined && s.mark !== "line",
  );
  const loose = shown.filter((s) => !stacked.includes(s));
  const values: (number | null)[] = [];
  for (const r of rows) {
    let pos = 0;
    let neg = 0;
    for (const s of stacked) {
      const v = r.plot[s.key] ?? null;
      if (v === null) continue;
      if (v >= 0) pos += v;
      else neg += v;
    }
    values.push(pos, neg);
    for (const s of loose) values.push(r.plot[s.key] ?? null);
  }
  return niceScale(values, 4, 100_000);
}

/** Minimum room per period label before labels are thinned. */
export const LABEL_ROOM = 58;

/**
 * Which period labels the axis prints: every `every`-th counted from the
 * right, so the latest period always has its label.
 */
export function labelEvery(n: number, plotWidth: number): number {
  const fit = Math.max(1, Math.floor(plotWidth / LABEL_ROOM));
  return Math.max(1, Math.ceil(n / fit));
}

/** True when the label of band `index` (of `n`) is printed. */
export function labelShown(index: number, n: number, every: number): boolean {
  return (n - 1 - index) % every === 0;
}

// ---------------------------------------------------------------------------
// Breakdowns with many labels (expense categories, reserve kinds)

export const OTHER_KEY = "__other";

export interface BreakdownSeries {
  /** the category or kind, or OTHER_KEY */
  key: string;
  label: string;
  slot: ChartSlot;
  /** the labels folded into this series */
  members: string[];
}

/**
 * Colour slots for the labels of a breakdown, by identity over the WHOLE
 * series (not the visible window, so a colour never moves when the view
 * changes): the labels ranked by absolute total, the first `max − 1` keep a
 * slot each in that rank and the rest fold into "Other" (the last slot).
 * With `max` or fewer labels, none is folded. Ties sort by label.
 */
export function breakdownSeries(
  totals: ReadonlyMap<string, bigint>,
  humanize: (label: string) => string,
  max = CHART_SLOTS,
): BreakdownSeries[] {
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const ranked = [...totals.entries()].sort(([a, x], [b, y]) => {
    const d = abs(y) - abs(x);
    if (d !== 0n) return d > 0n ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const keep = ranked.length <= max ? ranked : ranked.slice(0, max - 1);
  const rest = ranked.length <= max ? [] : ranked.slice(max - 1);
  const out: BreakdownSeries[] = keep.map(([label], i) => ({
    key: label,
    label: humanize(label),
    slot: (i + 1) as ChartSlot,
    members: [label],
  }));
  if (rest.length > 0) {
    out.push({
      key: OTHER_KEY,
      label: "Other",
      slot: max as ChartSlot,
      members: rest.map(([label]) => label),
    });
  }
  return out;
}

/** Sum of the breakdown amounts of `members` in one list; null when the list is absent. */
export function breakdownValue(
  list: readonly { label: string; amount: bigint }[] | null,
  members: readonly string[],
): bigint | null {
  if (list === null) return null;
  let sum = 0n;
  for (const row of list) if (members.includes(row.label)) sum += row.amount;
  return sum;
}

// ---------------------------------------------------------------------------
// Share of a whole (the segmented bar of one period)

export interface SharePart {
  key: string;
  label: string;
  slot: ChartSlot;
  amount: string;
  /** share of the positive total in tenths of a percent */
  shareTenths: number;
  /** "46.7%" */
  share: string;
  /** "47%": the label printed inside the segment (rounded, half up) */
  shareShort: string;
  /** width in percent of the bar (0 for zero or negative amounts) */
  width: number;
}

/**
 * Parts of one whole, largest first. Shares are of the sum of the positive
 * parts; a zero or negative part (a net reversal) is listed but draws nothing.
 */
export function shareParts(
  parts: readonly {
    key: string;
    label: string;
    slot: ChartSlot;
    amount: bigint;
  }[],
): { parts: SharePart[]; total: string; totalShare: string | null } {
  const positive = parts.reduce(
    (a, p) => a + (p.amount > 0n ? p.amount : 0n),
    0n,
  );
  const total = parts.reduce((a, p) => a + p.amount, 0n);
  const sorted = [...parts].sort((a, b) =>
    b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0,
  );
  return {
    total: formatValue("cents", total),
    // the shares are of the positive parts; with a negative part they do not describe the net total
    totalShare: parts.some((p) => p.amount < 0n) ? null : "100.0%",
    // a part with nothing in the period is absent, not listed at 0%
    parts: sorted
      .filter((p) => p.amount !== 0n)
      .map((p) => {
        const tenths =
          positive > 0n && p.amount > 0n
            ? Number((p.amount * 2000n + positive) / (2n * positive))
            : 0;
        return {
          key: p.key,
          label: p.label,
          slot: p.slot,
          amount: formatValue("cents", p.amount),
          shareTenths: tenths,
          share: `${Math.floor(tenths / 10)}.${tenths % 10}%`,
          shareShort: `${Math.floor((tenths + 5) / 10)}%`,
          width:
            positive > 0n && p.amount > 0n
              ? Number((p.amount * 1_000_000n) / positive) / 10_000
              : 0,
        };
      }),
  };
}

// ---------------------------------------------------------------------------
// Waterfall (cash flow of one period)

export interface WaterfallStepInput {
  key: string;
  label: string;
  /** signed: money in positive, money out negative */
  amount: bigint;
}

export type WaterfallKind = "in" | "out" | "total";

export interface WaterfallStep {
  key: string;
  label: string;
  kind: WaterfallKind;
  amount: bigint;
  /** running total before and after the step (cents) */
  from: bigint;
  to: bigint;
}

/**
 * The steps from the opening balance to the closing balance. The listed
 * movements rarely explain the whole change (capital-funded spending, loans,
 * timing of fee payments), so a remainder step labelled `otherLabel` makes
 * them add up exactly; it is omitted when zero. The last step is the change
 * itself, drawn from zero.
 */
export function waterfall(
  movements: readonly WaterfallStepInput[],
  change: bigint,
  labels: { other: string; change: string },
): WaterfallStep[] {
  const out: WaterfallStep[] = [];
  let run = 0n;
  const push = (key: string, label: string, amount: bigint) => {
    out.push({
      key,
      label,
      kind: amount >= 0n ? "in" : "out",
      amount,
      from: run,
      to: run + amount,
    });
    run += amount;
  };
  for (const m of movements) push(m.key, m.label, m.amount);
  const remainder = change - run;
  if (remainder !== 0n) push("other", labels.other, remainder);
  out.push({
    key: "change",
    label: labels.change,
    kind: "total",
    amount: change,
    from: 0n,
    to: change,
  });
  return out;
}
