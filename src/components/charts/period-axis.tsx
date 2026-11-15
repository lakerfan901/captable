"use client";

import { XAxis } from "recharts";
import { labelEvery, labelShown } from "./chart-model";

/** Height of the period axis band (tick labels under the plot). */
export const PERIOD_AXIS_HEIGHT = 28;

interface TickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value: string; index: number };
}

/**
 * The period axis: one band per period (`scale="band"`, so bars, lines and
 * points all sit at the band centre and the hit layer's bands match), short
 * labels ("Q2 ’27", "Jan ’27"), the highlighted (selected) period in bold.
 * Labels are thinned from the right so the latest period always has one.
 */
export function PeriodAxis({
  labels,
  highlightKey,
  plotWidth,
}: {
  /** short label by row key */
  labels: ReadonlyMap<string, string>;
  highlightKey: string | null;
  plotWidth: number;
}) {
  const n = labels.size;
  const every = labelEvery(n, plotWidth);
  return (
    <XAxis
      dataKey="key"
      type="category"
      scale="band"
      height={PERIOD_AXIS_HEIGHT}
      interval={0}
      tickLine={false}
      axisLine={{ stroke: "hsl(var(--border))" }}
      tick={(props: TickProps) =>
        renderTick(props, { labels, highlightKey, n, every })
      }
    />
  );
}

function renderTick(
  { x = 0, y = 0, payload }: TickProps,
  o: {
    labels: ReadonlyMap<string, string>;
    highlightKey: string | null;
    n: number;
    every: number;
  },
) {
  if (!payload) return <g />;
  const tx = Number(x);
  const ty = Number(y);
  if (!labelShown(payload.index, o.n, o.every)) return <g />;
  const on = payload.value === o.highlightKey;
  return (
    <text
      x={tx}
      y={ty + 12}
      textAnchor="middle"
      fontSize={11}
      fontWeight={on ? 600 : 400}
      fill={on ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))"}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {o.labels.get(payload.value) ?? payload.value}
    </text>
  );
}
