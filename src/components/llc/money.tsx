import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { trimUnits } from "@/server/llc/serialize";

/** Integer cents (a JS number on the wire) as "$1,234.56"; null → "—". */
export function Money({
  cents,
  className,
}: {
  cents: number | null | undefined;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      {cents === null || cents === undefined ? "—" : formatCents(cents)}
    </span>
  );
}

/** Units as a 6-dp wire string ("40.200000") shown trimmed ("40.2"); null → "—". */
export function Units({
  micro,
  className,
}: {
  micro: string | null | undefined;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      {micro === null || micro === undefined ? "—" : trimUnits(micro)}
    </span>
  );
}

/** A `YYYY-MM-DD` date as "Nov 30, 2026"; null → "—". */
export function IsoDateText({
  date,
  className,
}: {
  date: string | null | undefined;
  className?: string;
}) {
  return (
    <span className={className}>
      {date === null || date === undefined ? "—" : formatDateOnly(date)}
    </span>
  );
}
