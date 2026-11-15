"use client";

import { YAxis } from "recharts";
import { formatTick, type NiceScale, type ValueUnit } from "./chart-format";

/** Width of the value axis; the hit layer and end labels place themselves from it. */
export const VALUE_AXIS_WIDTH = 60;

/**
 * The value axis: clean ticks from `niceScale` (always through zero), compact
 * labels in the chart's unit ("$1.2M", "50%", "0.25x"), no axis line, recessive.
 * For money it is the "money axis" of 5.9; the same component serves percent
 * and DPI so every chart has exactly one value axis.
 */
export function MoneyAxis({
  scale,
  unit = "cents",
}: {
  scale: NiceScale;
  unit?: ValueUnit;
}) {
  return (
    <YAxis
      width={VALUE_AXIS_WIDTH}
      domain={[scale.min, scale.max]}
      ticks={scale.ticks}
      allowDataOverflow
      axisLine={false}
      tickLine={false}
      tickMargin={8}
      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
      tickFormatter={(v: number) => formatTick(unit, v)}
    />
  );
}
