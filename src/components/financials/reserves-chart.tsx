"use client";

import { useMemo } from "react";
import { PeriodChart } from "@/components/charts/period-chart";
import type { FundPeriodValues } from "@/lib/llc/financial-series";
import { reserveBreakdown, reservesSpec } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F7: reserve balance by kind (stacked areas) and the minimum operating
 * reserve required (line), at the end of each period. Colours follow the
 * kind over `colourSource`. Catalogue: reservesByKind, minimumReserve,
 * reserveBalance (tooltip and table).
 */
export function ReservesChart({
  colourSource,
  span = "third",
  ...props
}: TrendChartProps<FundPeriodValues> & {
  colourSource: readonly (FundPeriodValues | null)[];
}) {
  const spec = useMemo(
    () => reservesSpec(reserveBreakdown(colourSource)),
    [colourSource],
  );
  return (
    <PeriodChart
      id="reserves"
      title="Reserves"
      description={`Balance by kind at the end of each ${grainOf(props.periods)}, and the minimum required.`}
      series={spec.series}
      extras={spec.extras}
      span={span}
      {...props}
    />
  );
}
