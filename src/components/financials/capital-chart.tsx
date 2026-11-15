"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { FundPeriodValues } from "@/lib/llc/financial-series";
import { CAPITAL_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F5: paid-in capital, unreturned capital and cumulative distributions to
 * the Preferred class at the end of each period (lines). DPI, their ratio, is
 * in the tooltip and table rather than on a second axis. Catalogue keys:
 * paidInCapital, unreturnedCapital, cumulativeDistributionsToPreferred,
 * dpiBps.
 */
export function CapitalChart({
  span = "third",
  ...props
}: TrendChartProps<FundPeriodValues>) {
  return (
    <PeriodChart
      id="capital"
      title="Capital and DPI"
      description={`At the end of each ${grainOf(props.periods)}. DPI is cumulative distributions to the class ÷ paid-in capital.`}
      series={CAPITAL_SPEC.series}
      extras={CAPITAL_SPEC.extras}
      span={span}
      endLabels
      {...props}
    />
  );
}
