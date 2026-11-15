// The period control of the financial dashboard (04-investor-portal.md 5.9
// "Common interactions", package P14): grain, selected period, comparison
// and drill-down, kept in the URL query so a view can be bookmarked. Pure:
// relative imports only, tested. `use-period-state.tsx` is the thin React
// wrapper.
//
// Model (the owner-approved prototype): one SELECTED period of the grain
// (prev / next / the period list), a TREND of periods around it that the
// charts plot, and a drill stack: clicking a quarter shows its months,
// clicking a year its quarters; Back pops one level.

import { compareIso } from "../../lib/llc/dates";
import {
  comparisonPeriod,
  type Grain,
  groupByGrain,
  type MonthKey,
  type MonthRange,
  monthsBetween,
  type Period,
  periodByKey,
  periodLabel,
} from "../../lib/llc/financial-periods";

export type CompareMode = "previous" | "yearAgo" | "none";
export const COMPARE_MODES: readonly CompareMode[] = [
  "previous",
  "yearAgo",
  "none",
];

export interface PeriodState {
  grain: Grain;
  /** key of the selected period of `grain`; null = the latest */
  period: string | null;
  compare: CompareMode;
  /** drilled period keys, outermost first */
  drill: string[];
}

export const DEFAULT_PERIOD_STATE: PeriodState = {
  grain: "quarter",
  period: null,
  compare: "previous",
  drill: [],
};

export const GRAIN_OPTIONS: readonly { grain: Grain; label: string }[] = [
  { grain: "month", label: "Month" },
  { grain: "quarter", label: "Quarter" },
  { grain: "year", label: "Year" },
  { grain: "inception", label: "Since inception" },
];

const GRAIN_WORD: Record<Grain, string> = {
  month: "month",
  quarter: "quarter",
  year: "year",
  inception: "period",
};

/** The query keys this module reads and writes. */
export const PERIOD_QUERY_KEYS = ["grain", "period", "compare", "drill"];

const PERIOD_KEY_RE = /^(\d{4}(-\d{2}|-Q[1-4])?)$/;

/** Reads the state from a query; anything malformed falls back to the default. */
export function parsePeriodState(
  get: (key: string) => string | null,
): PeriodState {
  const grainRaw = get("grain");
  const grain = (["month", "quarter", "year", "inception"] as const).find(
    (g) => g === grainRaw,
  );
  const compareRaw = get("compare");
  const compare = COMPARE_MODES.find((c) => c === compareRaw);
  const period = get("period");
  const drill = (get("drill") ?? "")
    .split(",")
    .filter((k) => PERIOD_KEY_RE.test(k))
    .slice(0, 2);
  return {
    grain: grain ?? DEFAULT_PERIOD_STATE.grain,
    period: period !== null && PERIOD_KEY_RE.test(period) ? period : null,
    compare: compare ?? DEFAULT_PERIOD_STATE.compare,
    drill,
  };
}

/** Writes the state into a copy of `base` (other keys kept); defaults are omitted. */
export function serializePeriodState(
  state: PeriodState,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of PERIOD_QUERY_KEYS) out.delete(k);
  if (state.grain !== DEFAULT_PERIOD_STATE.grain) out.set("grain", state.grain);
  if (state.period !== null) out.set("period", state.period);
  if (state.compare !== DEFAULT_PERIOD_STATE.compare) {
    out.set("compare", state.compare);
  }
  if (state.drill.length > 0) out.set("drill", state.drill.join(","));
  return out;
}

// ---------------------------------------------------------------------------
// The view

/** The months that exist for the viewer: inception through the last month with figures. */
export interface Span {
  inception: MonthKey;
  last: MonthKey;
}

export interface PeriodView {
  grain: Grain;
  /** every period of the grain in the span, oldest first (the period list) */
  periods: Period[];
  /** index in `periods` of the selected period */
  selectedIndex: number;
  /** the period the tiles describe: the innermost drilled period, else the selected one */
  focus: Period;
  /** months of `focus` inside the span (the range to aggregate the tiles over) */
  focusRange: MonthRange;
  /** grain and range of the periods the charts plot */
  trendGrain: Exclude<Grain, "inception">;
  trendRange: MonthRange;
  /** key of the trend period to highlight (the selected one), or null */
  highlightKey: string | null;
  /** clicking a trend period drills into it */
  drillable: boolean;
  /** clicking a trend period selects it (month grain, not drilled) */
  pickable: boolean;
  drill: string[];
  /** the period list and prev / next are shown */
  showPicker: boolean;
  prevKey: string | null;
  nextKey: string | null;
  compare: CompareMode;
  /** the comparison period, or null (none, or "inception") */
  comparison: Period | null;
  /** "the months of Q2 2027" when drilled */
  drillCaption: string | null;
}

const TREND_WINDOW: Record<Exclude<Grain, "inception">, number> = {
  month: 12,
  quarter: 8,
  year: 99,
};

function clampRange(p: Period, span: Span): MonthRange {
  const from =
    compareIso(p.start, span.inception) < 0 ? span.inception : p.start;
  const lastMonth = p.months[p.months.length - 1] as MonthKey;
  const to = compareIso(lastMonth, span.last) > 0 ? span.last : lastMonth;
  return { from, to };
}

function overlaps(p: Period, span: Span): boolean {
  const lastMonth = p.months[p.months.length - 1] as MonthKey;
  return (
    compareIso(lastMonth, span.inception) >= 0 &&
    compareIso(p.start, span.last) <= 0
  );
}

function childGrainOf(p: Period): Exclude<Grain, "inception"> {
  return p.grain === "year" ? "quarter" : "month";
}

/**
 * The drill stack, kept only while it is valid: the first level is the
 * selected quarter or year (or, since inception, any quarter of the span);
 * each further level is a quarter of the year above it. Months are never
 * drilled into.
 */
function validDrill(
  drill: readonly string[],
  selected: Period,
  span: Span,
): Period[] {
  const out: Period[] = [];
  for (const key of drill) {
    let p: Period;
    try {
      p = periodByKey(key);
    } catch {
      break;
    }
    if (p.grain === "month" || !overlaps(p, span)) break;
    const parent = out[out.length - 1];
    if (parent === undefined) {
      if (selected.grain === "inception") {
        if (p.grain !== "quarter") break;
      } else if (p.key !== selected.key) {
        break;
      }
    } else if (
      p.grain !== childGrainOf(parent) ||
      !p.months.every((m) => parent.months.includes(m))
    ) {
      break;
    }
    out.push(p);
  }
  return out;
}

/**
 * The view of a state over the span: clamps the selected period to the
 * periods that exist (latest when unknown), validates the drill stack, and
 * places the trend window (the last 12 months / 8 quarters / every year,
 * ending at the selected period or later when it is early in the series).
 */
export function resolveView(state: PeriodState, span: Span): PeriodView {
  const spanRange = { from: span.inception, to: span.last };
  const grain = state.grain;
  const periods = groupByGrain(spanRange, grain, span.inception);
  let selectedIndex = periods.findIndex((p) => p.key === state.period);
  if (selectedIndex < 0) selectedIndex = periods.length - 1;
  const selected = periods[selectedIndex] as Period;
  const drilled = validDrill(state.drill, selected, span);
  const focus = drilled[drilled.length - 1] ?? selected;

  let trendGrain: Exclude<Grain, "inception">;
  let trendRange: MonthRange;
  let highlightKey: string | null = null;
  if (drilled.length > 0) {
    trendGrain = childGrainOf(focus);
    trendRange = clampRange(focus, span);
  } else if (grain === "inception") {
    trendGrain = "quarter";
    trendRange = spanRange;
  } else {
    trendGrain = grain;
    const win = TREND_WINDOW[grain];
    const end = Math.max(selectedIndex, Math.min(periods.length - 1, win - 1));
    const startIdx = Math.max(0, end - win + 1);
    trendRange = {
      from: clampRange(periods[startIdx] as Period, span).from,
      to: clampRange(periods[end] as Period, span).to,
    };
    highlightKey = selected.key;
  }

  const showPicker =
    grain !== "inception" &&
    (drilled.length === 0 ||
      (drilled.length === 1 && drilled[0]?.key === selected.key));
  const comparison =
    state.compare === "none" ? null : comparisonPeriod(focus, state.compare);
  return {
    grain,
    periods,
    selectedIndex,
    focus,
    focusRange:
      focus.grain === "inception" ? spanRange : clampRange(focus, span),
    trendGrain,
    trendRange,
    highlightKey,
    drillable: trendGrain !== "month",
    pickable: drilled.length === 0 && grain === "month",
    drill: drilled.map((p) => p.key),
    showPicker,
    prevKey:
      selectedIndex > 0 ? (periods[selectedIndex - 1]?.key ?? null) : null,
    nextKey:
      selectedIndex < periods.length - 1
        ? (periods[selectedIndex + 1]?.key ?? null)
        : null,
    compare: state.compare,
    comparison,
    drillCaption:
      drilled.length > 0
        ? `the ${trendGrain === "month" ? "months" : "quarters"} of ${periodLabel(focus.key)}`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Transitions

export function withGrain(state: PeriodState, grain: Grain): PeriodState {
  return { ...state, grain, period: null, drill: [] };
}

/**
 * Selects a period of the grain. A drill of the selected period itself
 * follows the selection (stepping through quarters keeps showing months).
 */
export function withPeriod(
  state: PeriodState,
  view: PeriodView,
  key: string,
): PeriodState {
  const followDrill =
    view.drill.length === 1 &&
    view.drill[0] === view.periods[view.selectedIndex]?.key;
  return { ...state, period: key, drill: followDrill ? [key] : [] };
}

/** Clicking a trend period: drill into it (quarters, years), or select it (months). */
export function withTrendClick(
  state: PeriodState,
  view: PeriodView,
  key: string,
): PeriodState {
  if (view.drillable) {
    const p = periodByKey(key);
    if (view.drill.length === 0 && p.grain === state.grain) {
      return { ...state, period: key, drill: [key] };
    }
    return { ...state, drill: [...view.drill, key] };
  }
  if (view.pickable) return { ...state, period: key };
  return state;
}

export function withBack(state: PeriodState, view: PeriodView): PeriodState {
  return { ...state, drill: view.drill.slice(0, -1) };
}

export function withCompare(
  state: PeriodState,
  compare: CompareMode,
): PeriodState {
  return { ...state, compare };
}

/** "Q2 2027 (previous quarter)", "Q3 2026 (same quarter a year earlier)". */
export function compareOptionLabel(
  view: PeriodView,
  mode: CompareMode,
): string {
  if (mode === "none") return "No comparison";
  const p = comparisonPeriod(view.focus, mode);
  if (p === null) return "No comparison";
  const word = GRAIN_WORD[view.focus.grain];
  return mode === "previous"
    ? `${periodLabel(p.key)} (previous ${word})`
    : `${periodLabel(p.key)} (same ${word} a year earlier)`;
}

/** Whole months from the end of `periodEnd`'s month to the month of `target` (0 when past). */
export function monthsUntil(
  periodLastMonth: MonthKey,
  targetMonth: MonthKey,
): number {
  if (compareIso(targetMonth, periodLastMonth) <= 0) return 0;
  return monthsBetween(periodLastMonth, targetMonth).length - 1;
}
