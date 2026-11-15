"use client";

import { PeriodChart } from "@/components/charts/period-chart";
import type { FundPeriodValues } from "@/lib/llc/financial-series";
import { REVENUE_SPEC } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F1, the headline chart: Gross Revenue, operating expenses and the
 * Management Fee accrued (bars) and net operating income (line) per period.
 * Catalogue keys: grossRevenue, operatingExpenses, managementFeeAccrued,
 * netOperatingIncome.
 */
export function RevenueChart({
  span = "full",
  ...props
}: TrendChartProps<FundPeriodValues>) {
  return (
    <PeriodChart
      id="revenue"
      title="Revenue and net operating income"
      description={`By ${grainOf(props.periods)}. Net operating income is Gross Revenue and other income less operating expenses and the Management Fee accrued, before reserves and distributions.`}
      series={REVENUE_SPEC.series}
      extras={REVENUE_SPEC.extras}
      span={span}
      height={280}
      {...props}
    />
  );
}
