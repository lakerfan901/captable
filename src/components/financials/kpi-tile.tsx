"use client";

import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { useChartPrintMode } from "@/components/charts/chart-frame";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TileView } from "./dashboard-model";

/** A 12-point trend in the de-emphasis grey, the current period as a dot in the accent. */
export function Sparkline({ values }: { values: readonly number[] }) {
  const n = values.length;
  if (n < 2) return null;
  const w = 52;
  const h = 24;
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const pt = (v: number, i: number) =>
    [
      2 + ((w - 6) * i) / (n - 1),
      3 + (h - 6) * (1 - (v - min) / span),
    ] as const;
  const d = values
    .map((v, i) => {
      const [x, y] = pt(v, i);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
  const [lx, ly] = pt(values[n - 1] as number, n - 1);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d={d}
        fill="none"
        stroke="hsl(var(--muted-foreground))"
        strokeOpacity={0.6}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={lx}
        cy={ly}
        r={3}
        fill="var(--chart-1)"
        stroke="hsl(var(--card))"
        strokeWidth={1.5}
      />
    </svg>
  );
}

/**
 * A KPI tile: label, value for the selected period, the change against the
 * comparison period (arrow, words and colour together; never colour alone),
 * a sub-line, and a sparkline. When a change is not shown for a reason
 * (partial period), the reason is shown instead.
 */
export function KpiTile({ tile }: { tile: TileView }) {
  const d = tile.delta;
  const print = useChartPrintMode();
  return (
    <Card className="min-w-0 break-inside-avoid" data-kpi={tile.key}>
      <div className="flex items-start justify-between gap-2 p-4 pb-2">
        <p className="text-sm font-medium text-muted-foreground">
          {tile.label}
        </p>
        <Sparkline values={tile.spark} />
      </div>
      <div className="flex flex-col gap-y-1 p-4 pt-0">
        <div
          className={cn(
            "whitespace-nowrap font-semibold",
            print ? "text-xl leading-7" : "text-2xl leading-8",
          )}
          data-testid="kpi-value"
        >
          {tile.value}
        </div>
        {d ? (
          <p
            className={cn(
              "flex flex-wrap items-center gap-1 text-xs font-medium",
              d.tone === "good" && "text-green-700 dark:text-green-500",
              d.tone === "bad" && "text-red-700 dark:text-red-400",
              d.tone === "neutral" && "text-muted-foreground",
            )}
            data-testid="kpi-delta"
          >
            {d.dir === "up" ? (
              <RiArrowUpLine className="h-3.5 w-3.5" aria-hidden="true" />
            ) : d.dir === "down" ? (
              <RiArrowDownLine className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            <span>{d.text}</span>
            <span className="font-normal text-muted-foreground">
              {d.against}
            </span>
          </p>
        ) : tile.deltaNote ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="kpi-delta-note"
          >
            {tile.deltaNote}
          </p>
        ) : null}
        {tile.sub ? (
          <p className="text-xs text-muted-foreground">{tile.sub}</p>
        ) : null}
      </div>
    </Card>
  );
}

/** The tile grid: two columns on narrow containers, up to `columns` on wide ones. */
export function KpiGrid({
  children,
  columns = 5,
}: {
  children: ReactNode;
  columns?: 4 | 5 | 6;
}) {
  // printed (700 px wide): three tiles a row, so the tiles fit the first page;
  // two on a phone's print preview
  if (useChartPrintMode()) {
    return (
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        data-testid="kpi-grid"
      >
        {children}
      </div>
    );
  }
  return (
    <div className="@container">
      <div
        className={cn(
          "grid grid-cols-2 gap-4",
          columns === 6 &&
            "@min-[44rem]:grid-cols-3 @min-[58rem]:grid-cols-4 @min-[72rem]:grid-cols-6",
          columns === 5 && "@min-[44rem]:grid-cols-3 @min-[58rem]:grid-cols-5",
          columns === 4 && "@min-[44rem]:grid-cols-4",
        )}
        data-testid="kpi-grid"
      >
        {children}
      </div>
    </div>
  );
}
