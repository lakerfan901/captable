// Period model of the financial dashboard (04-investor-portal.md 5.9
// "Periods", rules P33 and P37). Pure: relative imports only, no clock (the
// caller passes every date).
//
// - A month is identified by its first day ("2027-01-01", a `MonthKey`).
// - The fiscal year is the calendar year and quarters are calendar quarters
//   (2.11; `quarterOf` in ./dates).
// - A range is always whole months: `{ from, to }`, both month keys,
//   inclusive. There is no day-level range.
// - Grains: month, quarter, year, and "since inception" (one period from the
//   inception month through the end of the range).

import {
  addDays,
  addMonths,
  compareIso,
  type IsoDate,
  isIsoDate,
} from "./dates";
import { LlcMathError, roundDiv } from "./money";

export type MonthKey = IsoDate;
export type Grain = "month" | "quarter" | "year" | "inception";
export const GRAINS: readonly Grain[] = [
  "month",
  "quarter",
  "year",
  "inception",
];

export interface MonthRange {
  from: MonthKey;
  to: MonthKey;
}

export interface Period {
  /** "2027-01", "2027-Q1", "2027" or "inception" */
  key: string;
  grain: Grain;
  /** first month of the period */
  start: MonthKey;
  /** last day of the period */
  end: IsoDate;
  /** every calendar month of the period */
  months: MonthKey[];
  /** the months of the period inside the requested range */
  rangeMonths: MonthKey[];
}

const MONTH_NAMES = [
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

export function isMonthKey(v: string): v is MonthKey {
  return isIsoDate(v) && v.endsWith("-01");
}

function assertMonthKey(m: string): void {
  if (!isMonthKey(m)) {
    throw new LlcMathError("BAD_MONTH", `Not a month key (YYYY-MM-01): ${m}`);
  }
}

/** The month (first day) a date belongs to. */
export function monthOf(d: IsoDate): MonthKey {
  if (!isIsoDate(d)) throw new LlcMathError("BAD_DATE", `Not a date: ${d}`);
  return `${d.slice(0, 8)}01`;
}

/** Last day of the month. */
export function monthEnd(m: MonthKey): IsoDate {
  assertMonthKey(m);
  return addDays(addMonths(m, 1), -1);
}

export function addMonthKeys(m: MonthKey, n: number): MonthKey {
  assertMonthKey(m);
  return addMonths(m, n);
}

/** Every month from `from` through `to`, inclusive; empty when from > to. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  assertMonthKey(from);
  assertMonthKey(to);
  const out: MonthKey[] = [];
  for (let m = from; compareIso(m, to) <= 0; m = addMonths(m, 1)) out.push(m);
  return out;
}

function quarterIndex(m: MonthKey): 1 | 2 | 3 | 4 {
  return (Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

/** Key of the period of `grain` that contains `month`. */
export function periodKey(month: MonthKey, grain: Grain): string {
  assertMonthKey(month);
  switch (grain) {
    case "month":
      return month.slice(0, 7);
    case "quarter":
      return `${month.slice(0, 4)}-Q${quarterIndex(month)}`;
    case "year":
      return month.slice(0, 4);
    case "inception":
      return "inception";
  }
}

/** First month and every month of a calendar period key (not "inception"). */
function calendarPeriod(key: string): {
  grain: Exclude<Grain, "inception">;
  start: MonthKey;
  months: MonthKey[];
} {
  let m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) {
    const start = `${m[1]}-${m[2]}-01`;
    assertMonthKey(start);
    return { grain: "month", start, months: [start] };
  }
  m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (m) {
    const first = (Number(m[2]) - 1) * 3 + 1;
    const start = `${m[1]}-${String(first).padStart(2, "0")}-01`;
    return {
      grain: "quarter",
      start,
      months: monthsBetween(start, addMonths(start, 2)),
    };
  }
  m = /^(\d{4})$/.exec(key);
  if (m) {
    const start = `${m[1]}-01-01`;
    return {
      grain: "year",
      start,
      months: monthsBetween(start, addMonths(start, 11)),
    };
  }
  throw new LlcMathError("BAD_PERIOD", `Not a period key: ${key}`);
}

/** "Jan 2027", "Q1 2027", "FY2027", "Since inception". */
export function periodLabel(key: string): string {
  if (key === "inception") return "Since inception";
  const p = calendarPeriod(key);
  const year = p.start.slice(0, 4);
  switch (p.grain) {
    case "month":
      return `${MONTH_NAMES[Number(p.start.slice(5, 7)) - 1]} ${year}`;
    case "quarter":
      return `Q${quarterIndex(p.start)} ${year}`;
    case "year":
      return `FY${year}`;
  }
}

function intersect(months: MonthKey[], range: MonthRange): MonthKey[] {
  return months.filter(
    (m) => compareIso(m, range.from) >= 0 && compareIso(m, range.to) <= 0,
  );
}

/** A calendar period by key, with `rangeMonths` = all its months. */
export function periodByKey(key: string): Period {
  const p = calendarPeriod(key);
  const months = p.months;
  return {
    key,
    grain: p.grain,
    start: p.start,
    end: monthEnd(months[months.length - 1] as MonthKey),
    months,
    rangeMonths: [...months],
  };
}

/**
 * The periods of `grain` that overlap the range, oldest first. A period is
 * not cut at the range: `months` is the whole calendar period, `rangeMonths`
 * the part inside the range (fewer months = a partial period). For
 * "inception" there is one period, from `inceptionMonth` through `range.to`
 * (`range.from` is ignored).
 */
export function groupByGrain(
  range: MonthRange,
  grain: Grain,
  inceptionMonth: MonthKey,
): Period[] {
  assertMonthKey(range.from);
  assertMonthKey(range.to);
  assertMonthKey(inceptionMonth);
  if (grain === "inception") {
    const months = monthsBetween(inceptionMonth, range.to);
    if (months.length === 0) return [];
    return [
      {
        key: "inception",
        grain,
        start: inceptionMonth,
        end: monthEnd(range.to),
        months,
        rangeMonths: [...months],
      },
    ];
  }
  const out: Period[] = [];
  const seen = new Set<string>();
  for (const m of monthsBetween(range.from, range.to)) {
    const key = periodKey(m, grain);
    if (seen.has(key)) continue;
    seen.add(key);
    const p = periodByKey(key);
    out.push({ ...p, rangeMonths: intersect(p.months, range) });
  }
  return out;
}

/**
 * The period compared with `period` (5.9 "Comparison"): the previous period
 * of the same grain, or the same period one year earlier. Always a whole
 * calendar period. Null for "inception".
 */
export function comparisonPeriod(
  period: Pick<Period, "grain" | "start">,
  mode: "previous" | "yearAgo",
): Period | null {
  if (period.grain === "inception") return null;
  const shift =
    mode === "yearAgo"
      ? -12
      : period.grain === "month"
        ? -1
        : period.grain === "quarter"
          ? -3
          : -12;
  return periodByKey(periodKey(addMonths(period.start, shift), period.grain));
}

// ---------------------------------------------------------------------------
// Change against a comparison period

export type ChangeStatus =
  | "OK"
  /** no comparison value (no data, or no comparison period) */
  | "NOT_AVAILABLE"
  /** the comparison value is zero: a percentage has no meaning */
  | "PREVIOUS_ZERO"
  /** one of the two periods is partial or in progress: not compared */
  | "PARTIAL";

export interface Change {
  current: bigint | null;
  previous: bigint | null;
  /** current − previous; null unless status is OK or PREVIOUS_ZERO */
  amount: bigint | null;
  /**
   * Percentage change in basis points of a percent-of-1 (10000 = +100%):
   * roundDiv((current − previous) × 10000, |previous|), rounded half away
   * from zero. Null unless status is OK.
   */
  pctBps: bigint | null;
  status: ChangeStatus;
}

/**
 * Amount and percentage change. A partial or in-progress period on either
 * side is flagged PARTIAL and not compared (no amount, no percentage).
 */
export function changeOf(
  current: { value: bigint | null; partial: boolean } | null,
  previous: { value: bigint | null; partial: boolean } | null,
): Change {
  const cur = current?.value ?? null;
  const prev = previous?.value ?? null;
  const base = { current: cur, previous: prev };
  if (current?.partial || previous?.partial) {
    return { ...base, amount: null, pctBps: null, status: "PARTIAL" };
  }
  if (cur === null || prev === null) {
    return { ...base, amount: null, pctBps: null, status: "NOT_AVAILABLE" };
  }
  const amount = cur - prev;
  if (prev === 0n) {
    return { ...base, amount, pctBps: null, status: "PREVIOUS_ZERO" };
  }
  const abs = prev < 0n ? -prev : prev;
  return {
    ...base,
    amount,
    pctBps: roundDiv(amount * 10_000n, abs),
    status: "OK",
  };
}

// ---------------------------------------------------------------------------
// Published-through date (P33)

/**
 * P33: the latest period end among the QUARTERLY and ANNUAL reports visible to
 * the holder (the caller passes only visible reports; visibility is decided
 * elsewhere). Notices and K-1 reports do not move the date. Null when there
 * is no such report.
 */
export function publishedThrough(
  visibleReports: readonly { type: string; periodEnd: IsoDate | null }[],
): IsoDate | null {
  let best: IsoDate | null = null;
  for (const r of visibleReports) {
    if (r.type !== "QUARTERLY" && r.type !== "ANNUAL") continue;
    if (r.periodEnd === null) continue;
    if (best === null || compareIso(r.periodEnd, best) > 0) best = r.periodEnd;
  }
  return best;
}

/** A month is published when its last day is on or before the date. */
export function isMonthPublished(
  month: MonthKey,
  through: IsoDate | null,
): boolean {
  return through !== null && compareIso(monthEnd(month), through) <= 0;
}

/**
 * The rows whose month is published (P33): whole months whose last day is on
 * or before `through`; nothing when `through` is null.
 */
export function cutAtPublishedThrough<T extends { month: MonthKey }>(
  rows: readonly T[],
  through: IsoDate | null,
): T[] {
  return rows.filter((r) => isMonthPublished(r.month, through));
}

/**
 * Clamps a range to the published-through date (5.9 export: "`to` is clamped
 * to the published-through date"). Null when nothing of the range is
 * published.
 */
export function clampRange(
  range: MonthRange,
  through: IsoDate | null,
): MonthRange | null {
  if (through === null) return null;
  let last = monthOf(through);
  if (!isMonthPublished(last, through)) last = addMonths(last, -1);
  const to = compareIso(range.to, last) <= 0 ? range.to : last;
  if (compareIso(range.from, to) > 0) return null;
  return { from: range.from, to };
}
