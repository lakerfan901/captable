"use client";

import { cn } from "@/lib/utils";
import { type ChartSlot, type SeriesMark, slotColor } from "./chart-model";

export interface LegendItem {
  key: string;
  label: string;
  slot: ChartSlot;
  mark: SeriesMark;
}

/** The key of a series: a square for bars and areas, a short stroke for lines (the mark it stands for). */
export function SeriesKey({
  slot,
  mark,
  off = false,
}: {
  slot: ChartSlot;
  mark: SeriesMark;
  off?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-[2px]",
        mark === "line" ? "h-[3px] w-3.5" : "h-2.5 w-2.5",
        off && "bg-border!",
      )}
      style={{ background: off ? undefined : slotColor(slot) }}
    />
  );
}

/**
 * The legend of a chart with two or more series. Each item is a button that
 * shows or hides its series (`aria-pressed` = shown); the last shown series
 * cannot be hidden. With `onToggle` absent the legend is static.
 */
export function ChartLegend({
  items,
  hidden,
  onToggle,
  chartId,
}: {
  items: readonly LegendItem[];
  hidden?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  chartId: string;
}) {
  if (items.length < 2) return null;
  return (
    <fieldset
      aria-label="Series"
      className="m-0 -ml-1.5 mb-3 flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 border-0 p-0"
      data-testid={`legend-${chartId}`}
    >
      {items.map((it) => {
        const off = hidden?.has(it.key) ?? false;
        const body = (
          <>
            <SeriesKey slot={it.slot} mark={it.mark} off={off} />
            <span>{it.label}</span>
          </>
        );
        const cls =
          "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground";
        return onToggle ? (
          <button
            key={it.key}
            type="button"
            aria-pressed={!off}
            title={`${off ? "Show" : "Hide"} ${it.label}`}
            data-series={it.key}
            onClick={() => onToggle(it.key)}
            className={cn(
              cls,
              "hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
              off && "text-muted-foreground line-through",
            )}
          >
            {body}
          </button>
        ) : (
          <span key={it.key} className={cls}>
            {body}
          </span>
        );
      })}
    </fieldset>
  );
}
