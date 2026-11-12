// Business days (R44): Monday–Friday excluding the 11 US federal holidays on
// their observed dates, plus optional extra closures.

import { addDays, dayOfWeek, type IsoDate } from "./dates";

export interface BusinessDayOptions {
  holidays?: "US_FEDERAL" | "NONE";
  saturdayObservedOnFriday?: boolean;
  extraHolidays?: readonly IsoDate[];
}

function iso(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The nth (1-based) given weekday of a month. */
function nthWeekday(
  y: number,
  m: number,
  weekday: number,
  nth: number,
): IsoDate {
  const first = dayOfWeek(iso(y, m, 1));
  const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  return iso(y, m, day);
}

function lastWeekday(y: number, m: number, weekday: number): IsoDate {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dayOfWeek(iso(y, m, lastDay));
  return iso(y, m, lastDay - ((last - weekday + 7) % 7));
}

export function usFederalHolidays(
  year: number,
  opts?: Pick<BusinessDayOptions, "saturdayObservedOnFriday">,
): { name: string; date: IsoDate; observedOn: IsoDate }[] {
  const saturdayToFriday = opts?.saturdayObservedOnFriday ?? true;
  const list: [string, IsoDate][] = [
    ["New Year's Day", iso(year, 1, 1)],
    ["Birthday of Martin Luther King, Jr.", nthWeekday(year, 1, 1, 3)],
    ["Washington's Birthday", nthWeekday(year, 2, 1, 3)],
    ["Memorial Day", lastWeekday(year, 5, 1)],
    ["Juneteenth National Independence Day", iso(year, 6, 19)],
    ["Independence Day", iso(year, 7, 4)],
    ["Labor Day", nthWeekday(year, 9, 1, 1)],
    ["Columbus Day", nthWeekday(year, 10, 1, 2)],
    ["Veterans Day", iso(year, 11, 11)],
    ["Thanksgiving Day", nthWeekday(year, 11, 4, 4)],
    ["Christmas Day", iso(year, 12, 25)],
  ];
  return list.map(([name, date]) => {
    const dow = dayOfWeek(date);
    let observedOn = date;
    if (dow === 6 && saturdayToFriday) observedOn = addDays(date, -1);
    else if (dow === 0) observedOn = addDays(date, 1);
    return { name, date, observedOn };
  });
}

export function isBusinessDay(d: IsoDate, opts?: BusinessDayOptions): boolean {
  const dow = dayOfWeek(d);
  if (dow === 0 || dow === 6) return false;
  if (opts?.extraHolidays?.includes(d)) return false;
  if ((opts?.holidays ?? "US_FEDERAL") === "NONE") return true;
  const year = Number(d.slice(0, 4));
  const sat = {
    saturdayObservedOnFriday: opts?.saturdayObservedOnFriday ?? true,
  };
  for (const y of [year - 1, year, year + 1]) {
    for (const h of usFederalHolidays(y, sat)) {
      if (h.observedOn === d) return false;
    }
  }
  return true;
}

/**
 * n ≥ 1: the n-th business day strictly after d. n = 0: d unchanged.
 * n < 0: the |n|-th business day strictly before d.
 */
export function addBusinessDays(
  d: IsoDate,
  n: number,
  opts?: BusinessDayOptions,
): IsoDate {
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  let current = d;
  while (remaining > 0) {
    current = addDays(current, step);
    if (isBusinessDay(current, opts)) remaining -= 1;
  }
  return current;
}

export function nextBusinessDay(
  d: IsoDate,
  opts?: BusinessDayOptions,
): IsoDate {
  return addBusinessDays(d, 1, opts);
}

/** Business days in (from, to]; 0 if to ≤ from. */
export function businessDaysBetween(
  from: IsoDate,
  to: IsoDate,
  opts?: BusinessDayOptions,
): number {
  let count = 0;
  let current = from;
  while (current < to) {
    current = addDays(current, 1);
    if (isBusinessDay(current, opts)) count += 1;
  }
  return count;
}
