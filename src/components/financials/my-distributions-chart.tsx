"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { HolderPeriodValues } from "@/lib/llc/financial-series";
import { MY_DISTRIBUTIONS_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * M1: the holder's own distributions per period by tier (stacked); offsets,
 * net paid and cumulative distributions in the tooltip and table. Holder
 * catalogue keys: preferredReturnPaid, capitalReturned, residualPaid,
 * defaultOffsets, taxAdvanceOffsets, netPaid, cumulativeGrossDistributions.
 */
export function MyDistributionsChart({
  span = "full",
  ...props
}: TrendChartProps<HolderPeriodValues>) {
  return (
    <PeriodChart
      id="my-distributions"
      title="Your distributions, by tier"
      description={`What you received each ${grainOf(props.periods)}, before offsets.`}
      series={MY_DISTRIBUTIONS_SPEC.series}
      extras={MY_DISTRIBUTIONS_SPEC.extras}
      span={span}
      height={260}
      {...props}
    />
  );
}
