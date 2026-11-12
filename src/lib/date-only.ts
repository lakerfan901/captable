import { z } from "zod";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that is a real calendar date. */
export function isValidDateOnly(s: string): boolean {
  if (!DATE_ONLY_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export const ZDateOnly = z
  .string()
  .refine(isValidDateOnly, "Use the format YYYY-MM-DD");

export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fromDateOnly(s: string): Date {
  if (!isValidDateOnly(s)) {
    throw new RangeError(`Invalid date: ${s}`);
  }
  return new Date(`${s}T00:00:00.000Z`);
}

/** Calendar date of `now` in `timeZone`, as `YYYY-MM-DD`. */
export function todayInTimeZone(
  timeZone: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function compareDateOnly(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function maxDateOnly(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minDateOnly(a: string, b: string): string {
  return a <= b ? a : b;
}

/** `to − from` in whole days. */
export function diffInDays(from: string, to: string): number {
  return Math.round(
    (fromDateOnly(to).getTime() - fromDateOnly(from).getTime()) / 86_400_000,
  );
}

/** "Nov 30, 2026". */
export function formatDateOnly(s: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(fromDateOnly(s));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
