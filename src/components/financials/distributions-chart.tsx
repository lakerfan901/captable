"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { FundPeriodValues } from "@/lib/llc/financial-series";
import { DISTRIBUTIONS_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F4: distributions paid per period by tier (stacked): preferred return,
 * return of capital, residual to the Preferred class and residual to the
 * Common class. Cumulative distributions are in the tooltip and table (one
 * value axis only). Catalogue keys: distributions.preferredReturn,
 * distributions.returnOfCapital, distributions.residualPreferred,
 * distributions.residualCommon, cumulativeDistributions.
 */
export function DistributionsChart({
  span = "half",
  ...props
}: TrendChartProps<FundPeriodValues>) {
  return (
    <PeriodChart
      id="distributions"
      title="Distributions paid, by tier"
      description={`By ${grainOf(props.periods)}, by payment date.`}
      series={DISTRIBUTIONS_SPEC.series}
      extras={DISTRIBUTIONS_SPEC.extras}
      span={span}
      {...props}
    />
  );
}
