"use client";

import { cn } from "@/lib/utils";
import { slotColor, type TooltipLine, type TooltipModel } from "./chart-model";

function Line({ line, className }: { line: TooltipLine; className?: string }) {
  return (
    <div
      className={cn("flex items-center gap-1.5 whitespace-nowrap", className)}
    >
      <span
        aria-hidden="true"
        className="inline-block h-[3px] w-2.5 shrink-0 rounded-[2px]"
        style={{ background: line.slot ? slotColor(line.slot) : "transparent" }}
      />
      <strong className="font-semibold tabular-nums">{line.value}</strong>
      <span className="text-muted-foreground">{line.label}</span>
    </div>
  );
}

/**
 * The readout of one period: every visible series (value first, name
 * second, keyed by a short stroke of its colour), the stacked total, the
 * figures shown only here and in the table, and a hint ("Click to see its
 * months"). It is placed by the hit layer; the same text is the focused
 * period's accessible name, so this element is hidden from screen readers.
 */
export function ChartTooltip({
  model,
  hint,
  style,
}: {
  model: TooltipModel;
  hint?: string | null;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="chart-tooltip"
      className="pointer-events-none absolute z-20 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
      style={style}
    >
      <div className="mb-1 font-semibold" data-testid="chart-tooltip-title">
        {model.title}
      </div>
      {model.note ? (
        <div className="mb-1 text-muted-foreground">{model.note}</div>
      ) : null}
      {model.lines.map((l) => (
        <Line key={l.key} line={l} />
      ))}
      {model.total ? (
        <Line line={model.total} className="mt-0.5 border-t pt-0.5" />
      ) : null}
      {model.extras.map((l) => (
        <Line key={l.key} line={l} />
      ))}
      {hint ? <div className="mt-1 text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
