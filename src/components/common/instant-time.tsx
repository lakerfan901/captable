"use client";

import { formatInstant, formatInstantDate } from "@/lib/company-time";
import { useEntity } from "@/providers/entity-provider";

/**
 * An instant shown in the company's time zone, labelled with the zone
 * ("Nov 14, 2026, 3:04 PM MST"); `dateOnly` shows just the company-zone date.
 */
export function InstantTime({
  at,
  dateOnly = false,
}: {
  at: Date | string | null | undefined;
  dateOnly?: boolean;
}) {
  const { timezone } = useEntity();
  if (at === null || at === undefined) return <>—</>;
  const d = at instanceof Date ? at : new Date(at);
  const text = dateOnly
    ? formatInstantDate(d, timezone)
    : formatInstant(d, timezone);
  if (Number.isNaN(d.getTime())) return <>{text}</>;
  return <time dateTime={d.toISOString()}>{text}</time>;
}
