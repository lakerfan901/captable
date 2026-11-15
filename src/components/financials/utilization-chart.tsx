"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { FundPeriodValues } from "@/lib/llc/financial-series";
import { hasUtilization, UTILIZATION_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F8: utilization as reported by the Manager (0–100%); for several months,
 * the mean of the months that have a value. A month without a value is a
 * gap. Renders nothing when no month of `months` has a value (the chart is
 * absent, not empty). Catalogue key: utilizationBps.
 */
export function UtilizationChart({
  months,
  span = "third",
  ...props
}: TrendChartProps<FundPeriodValues> & {
  /** every month record the dashboard has, to decide whether the chart exists */
  months: readonly { utilizationBps: number | null }[];
}) {
  if (!hasUtilization(months)) return null;
  return (
    <PeriodChart
      id="utilization"
      title="Utilization"
      description={`As reported by the Manager. For a ${grainOf(props.periods)}, the average of its months with a figure.`}
      series={UTILIZATION_SPEC.series}
      extras={UTILIZATION_SPEC.extras}
      unit="bps"
      fixedMax={10_000}
      span={span}
      endLabels
      {...props}
    />
  );
}
