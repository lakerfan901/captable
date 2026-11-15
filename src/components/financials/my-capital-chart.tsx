"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { HolderPeriodValues } from "@/lib/llc/financial-series";
import { MY_CAPITAL_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * M2: the holder's paid-in capital, unreturned capital and unpaid preferred
 * return at the end of each period (lines); the holder's DPI in the tooltip
 * and table. Holder catalogue keys: paidIn, unreturnedCapital,
 * preferredReturnUnpaid, dpiBps.
 */
export function MyCapitalChart({
  span = "half",
  ...props
}: TrendChartProps<HolderPeriodValues>) {
  return (
    <PeriodChart
      id="my-capital"
      title="Your capital"
      description={`At the end of each ${grainOf(props.periods)}. Your DPI is your distributions ÷ your paid-in capital.`}
      series={MY_CAPITAL_SPEC.series}
      extras={MY_CAPITAL_SPEC.extras}
      span={span}
      endLabels
      {...props}
    />
  );
}
