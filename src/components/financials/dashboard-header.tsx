"use client";

import type { ReactNode } from "react";
import { formatDate } from "@/components/charts/chart-format";
import { periodRowLabel } from "@/components/charts/chart-model";
import { Badge } from "@/components/ui/badge";
import type { IsoDate } from "@/lib/llc/dates";
import { monthEnd } from "@/lib/llc/financial-periods";
import type { AggregatedPeriod } from "@/lib/llc/financial-series";

/** "Published through Jun 30, 2027" (P33), or the source line of the team's live view. */
export function ThroughLine({
  publishedThrough,
  note,
  variant = "published",
}: {
  publishedThrough: IsoDate;
  note?: ReactNode;
  /** "published": the investor's (snapshot) figures; "books": the team's live figures */
  variant?: "published" | "books";
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="published-through"
    >
      <Badge variant={variant === "published" ? "success" : "secondary"}>
        {variant === "published" ? "Published through" : "Books through"}{" "}
        {formatDate(publishedThrough)}
      </Badge>
      {note ? <span className="text-muted-foreground">{note}</span> : null}
    </div>
  );
}

/** The selected period as a heading, with its dates and any restatement note (P35). */
export function PeriodHeading({
  period,
  restatedOn,
}: {
  period: AggregatedPeriod<unknown>;
  /** dates on which months of the period were restated */
  restatedOn: readonly string[];
}) {
  const first = period.presentMonths[0] ?? period.start;
  const last =
    period.presentMonths[period.presentMonths.length - 1] ?? period.start;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="text-xl font-semibold tracking-tight"
          data-testid="period-heading"
        >
          {periodRowLabel(period)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {formatDate(first)} – {formatDate(monthEnd(last))}
        </p>
      </div>
      {restatedOn.length > 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="restated-note"
        >
          Restated on {restatedOn.map((d) => formatDate(d)).join(", ")}: the
          figures shown are the restated ones.
        </p>
      ) : null}
    </div>
  );
}

/** The empty state of a holder with no published period (6.3). */
export function NoPeriods() {
  return (
    <div className="rounded-lg border p-6" data-testid="no-periods">
      <p className="text-sm font-medium">
        No financial periods have been published yet.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Figures appear here when the Manager releases a quarterly or annual
        report to you.
      </p>
    </div>
  );
}
