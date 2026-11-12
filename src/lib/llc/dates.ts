// Calendar-date helpers on "YYYY-MM-DD" strings. UTC arithmetic only.

import { LlcMathError } from "./money";

export type IsoDate = string;

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(d: IsoDate): { y: number; m: number; day: number } {
  const match = ISO_RE.exec(d);
  if (!match) throw new LlcMathError("BAD_DATE", `Not a YYYY-MM-DD date: ${d}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const day = Number(match[3]);
  if (m < 1 || m > 12 || day < 1 || day > daysInMonth(y, m)) {
    throw new LlcMathError("BAD_DATE", `Not a calendar date: ${d}`);
  }
  return { y, m, day };
}

function toMs(d: IsoDate): number {
  const { y, m, day } = parts(d);
  return Date.UTC(y, m - 1, day);
}

function fromMs(ms: number): IsoDate {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function build(y: number, m: number, day: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isIsoDate(v: string): v is IsoDate {
  const match = ISO_RE.exec(v);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const day = Number(match[3]);
  return m >= 1 && m <= 12 && day >= 1 && day <= daysInMonth(y, m);
}

export function compareIso(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  const diff = toMs(a) - toMs(b);
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

/** to − from in days; may be negative. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toMs(to) - toMs(from)) / MS_PER_DAY);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromMs(toMs(d) + n * MS_PER_DAY);
}

/** Clamps the day to the end of the target month. */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const { y, m, day } = parts(d);
  const index = y * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12 + 1;
  return build(ty, tm, Math.min(day, daysInMonth(ty, tm)));
}

export function addYears(d: IsoDate, n: number): IsoDate {
  return addMonths(d, 12 * n);
}

export function minIso(...d: IsoDate[]): IsoDate {
  let best: IsoDate | undefined;
  for (const x of d)
    if (best === undefined || compareIso(x, best) < 0) best = x;
  if (best === undefined)
    throw new LlcMathError("EMPTY", "minIso needs at least one date");
  return best;
}

export function maxIso(...d: IsoDate[]): IsoDate {
  let best: IsoDate | undefined;
  for (const x of d)
    if (best === undefined || compareIso(x, best) > 0) best = x;
  if (best === undefined)
    throw new LlcMathError("EMPTY", "maxIso needs at least one date");
  return best;
}

/** 0 = Sunday. */
export function dayOfWeek(d: IsoDate): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return new Date(toMs(d)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export function quarterOf(d: IsoDate): {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  start: IsoDate;
  end: IsoDate;
} {
  const { y, m } = parts(d);
  const quarter = (Math.floor((m - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    year: y,
    quarter,
    start: build(y, startMonth, 1),
    end: build(y, endMonth, daysInMonth(y, endMonth)),
  };
}
