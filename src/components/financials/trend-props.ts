import type { FocusRequest } from "@/components/charts/chart-hit-layer";
import type { ChartActivation } from "@/components/charts/period-chart";
import type { Grain } from "@/lib/llc/financial-periods";
import type { AggregatedPeriod } from "@/lib/llc/financial-series";

/** What every period chart of the dashboard takes: aggregated periods and the interaction hooks. */
export interface TrendChartProps<V> {
  /** `aggregate` / `aggregateHolder` output: the periods to plot, oldest first */
  periods: readonly AggregatedPeriod<V>[];
  /** the selected period, drawn with a band behind it */
  highlightKey?: string | null;
  /** click / Enter on a period: drill into it or select it */
  activation?: ChartActivation | null;
  /** focus a period of this chart (focus returns there after Back) */
  focusRequest?: FocusRequest | null;
  span?: "full" | "half" | "third";
}

const GRAIN_WORDS: Record<Grain, string> = {
  month: "month",
  quarter: "quarter",
  year: "year",
  inception: "period",
};

/** "By quarter" / "At the end of each quarter" for a chart's description. */
export function grainOf(periods: readonly { grain: Grain }[]): string {
  return GRAIN_WORDS[periods[0]?.grain ?? "month"];
}
