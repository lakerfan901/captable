// One way to show dates and times (LLC mode and the shared admin tables).
//
// - An instant (a `DateTime` column: sentAt, occurredAt, createdAt...) is
//   shown in the company's time zone with the zone abbreviation:
//   "Nov 14, 2026, 3:04 PM MST".
// - The calendar date of an instant is the date in the company's zone.
// - A date-only value (`@db.Date`, "YYYY-MM-DD") is a plain calendar date and
//   is never shifted by a zone ("Nov 30, 2026").
//
// Built from `formatToParts` so Node (server render) and the browser produce
// the same string. Pure: no clock reads; relative imports only.

import { fromDateOnly, isValidDateOnly } from "./date-only";

/** The zone used when a company has none (or an invalid one). */
export const DEFAULT_COMPANY_TIME_ZONE = "America/Denver";

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

/** `tz` when it is a valid IANA zone, else the default. */
export function resolveTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_COMPANY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_COMPANY_TIME_ZONE;
  }
}

type Instant = Date | string | number;

function toDate(at: Instant): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  zone: string;
}

function zonedParts(d: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    zone: get("timeZoneName") || timeZone,
  };
}

function dateText(p: { year: number; month: number; day: number }): string {
  return `${MONTHS[p.month - 1]} ${p.day}, ${p.year}`;
}

/** The zone abbreviation of `tz` at `at` ("MST", "MDT", "GMT+2"). */
export function zoneAbbreviation(at: Instant, tz: string | null | undefined) {
  const d = toDate(at) ?? new Date(0);
  return zonedParts(d, resolveTimeZone(tz)).zone;
}

/** "Nov 14, 2026, 3:04 PM MST" (the company zone, labelled). "—" when empty. */
export function formatInstant(
  at: Instant | null | undefined,
  tz: string | null | undefined,
): string {
  if (at === null || at === undefined || at === "") return "—";
  const d = toDate(at);
  if (!d) return "—";
  const p = zonedParts(d, resolveTimeZone(tz));
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  const mm = String(p.minute).padStart(2, "0");
  return `${dateText(p)}, ${h12}:${mm} ${ampm} ${p.zone}`;
}

/** "Nov 14, 2026": the calendar date of an instant in the company zone. */
export function formatInstantDate(
  at: Instant | null | undefined,
  tz: string | null | undefined,
): string {
  if (at === null || at === undefined || at === "") return "—";
  const d = toDate(at);
  if (!d) return "—";
  return dateText(zonedParts(d, resolveTimeZone(tz)));
}

/**
 * "Nov 30, 2026" for a date-only value: a "YYYY-MM-DD" string or a `Date` at
 * UTC midnight (how Prisma returns `@db.Date`). Never zone-shifted.
 */
export function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const ymd =
    typeof value === "string" ? value.slice(0, 10) : value.toISOString();
  const s = ymd.slice(0, 10);
  if (!isValidDateOnly(s)) return "—";
  const d = fromDateOnly(s);
  return dateText({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
}

/** "Times are shown in America/Denver (MST)." */
export function timeZoneNote(tz: string | null | undefined, at: Instant) {
  const zone = resolveTimeZone(tz);
  return `Times are shown in ${zone} (${zoneAbbreviation(at, zone)}).`;
}

// The e-sign audit summaries were written with the time baked in, in the
// server's zone and unlabelled (`... at Nov 14, 2026 3:04 PM`, dayjs "lll").
// Displays drop that suffix and show `occurredAt` in the company zone instead;
// the stored text is unchanged.
const BAKED_TIME_SUFFIX =
  / at (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4} \d{1,2}:\d{2} (AM|PM)$/;

export function stripBakedTime(summary: string): string {
  return summary.replace(BAKED_TIME_SUFFIX, "");
}
