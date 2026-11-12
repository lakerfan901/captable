"use client";

import type { ReactNode } from "react";
import { Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "@/lib/utils";

/**
 * Donut chart on Recharts. Replaces `@tremor/react`'s DonutChart (React 18 /
 * Tailwind 3 only) and keeps its look: a full ring starting at 12 o'clock,
 * 75% inner radius, no slice borders, and Tremor's default color order
 * (Tailwind v3 `*-500` shades).
 */
const DEFAULT_COLORS = [
  "#3b82f6", // blue-500
  "#06b6d4", // cyan-500
  "#0ea5e9", // sky-500
  "#6366f1", // indigo-500
  "#8b5cf6", // violet-500
  "#a855f7", // purple-500
  "#d946ef", // fuchsia-500
  "#64748b", // slate-500
  "#6b7280", // gray-500
  "#71717a", // zinc-500
  "#737373", // neutral-500
  "#78716c", // stone-500
  "#ef4444", // red-500
  "#f97316", // orange-500
  "#f59e0b", // amber-500
  "#eab308", // yellow-500
  "#84cc16", // lime-500
  "#22c55e", // green-500
  "#10b981", // emerald-500
  "#14b8a6", // teal-500
  "#ec4899", // pink-500
  "#f43f5e", // rose-500
];
const FALLBACK_COLOR = "#6b7280"; // gray-500

export type DonutTooltipPayload = { name: string; value: number };

type DonutChartProps<T extends Record<string, unknown>> = {
  data: T[];
  /** Key of the numeric value in each row. */
  category: keyof T & string;
  /** Key of the slice name in each row. */
  index: keyof T & string;
  colors?: string[];
  showAnimation?: boolean;
  animationDuration?: number;
  className?: string;
  customTooltip?: (payload: DonutTooltipPayload) => ReactNode;
};

export function DonutChart<T extends Record<string, unknown>>({
  data,
  category,
  index,
  colors = DEFAULT_COLORS,
  showAnimation = false,
  animationDuration = 900,
  className,
  customTooltip,
}: DonutChartProps<T>) {
  const slices = data.map((row, i) => ({
    ...row,
    fill: colors[i] ?? FALLBACK_COLOR,
  }));

  return (
    <div className={cn("h-40 w-full", className)}>
      <ResponsiveContainer className="h-full w-full">
        <PieChart margin={{ top: 0, left: 0, right: 0, bottom: 0 }}>
          <Pie
            data={slices}
            dataKey={category}
            nameKey={index}
            cx="50%"
            cy="50%"
            startAngle={90}
            endAngle={-270}
            innerRadius="75%"
            outerRadius="100%"
            stroke="none"
            isAnimationActive={showAnimation}
            animationDuration={animationDuration}
            style={{ outline: "none" }}
          />
          <Tooltip
            wrapperStyle={{ outline: "none" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const item = payload?.[0];
              if (!active || !item || !customTooltip) return null;
              return customTooltip({
                name: String(item.name),
                value: Number(item.value),
              });
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
