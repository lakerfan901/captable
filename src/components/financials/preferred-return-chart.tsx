"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { FundPeriodValues } from "@/lib/llc/financial-series";
import { PREFERRED_RETURN_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F6: preferred return accrued and paid to date (areas) and the unpaid
 * balance (line), at the end of each period. Catalogue keys:
 * preferredReturnAccruedToDate, preferredReturnPaidToDate,
 * preferredReturnUnpaid.
 */
export function PreferredReturnChart({
  span = "third",
  ...props
}: TrendChartProps<FundPeriodValues>) {
  return (
    <PeriodChart
      id="preferred-return"
      title="Preferred return"
      description={`Accrued and paid to date, and the unpaid balance, at the end of each ${grainOf(props.periods)}.`}
      series={PREFERRED_RETURN_SPEC.series}
      extras={PREFERRED_RETURN_SPEC.extras}
      span={span}
      endLabels
      {...props}
    />
  );
}
