"use client";

import { useMemo } from "react";
import { breakdownValue, shareParts } from "@/components/charts/chart-model";
import { PeriodChart } from "@/components/charts/period-chart";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { periodLabel } from "@/lib/llc/financial-periods";
import type { FundPeriod, FundPeriodValues } from "@/lib/llc/financial-series";
import { expenseBreakdown, expensesSpec } from "./chart-specs";
import { grainOf, type TrendChartProps } from "./trend-props";

/**
 * F2: expenses by category, stacked per period (operating and paid from
 * capital; they sum to total expenses), categories humanised as in the
 * report. Colours follow the category over `colourSource` (every month the
 * dashboard has), so they do not move when the view changes; past seven
 * categories the smallest fold into "Other". "Share" shows the split of the
 * selected period as one segmented bar. Catalogue: expensesByCategory,
 * totalExpenses.
 */
export function ExpensesChart({
  colourSource,
  sharePeriod,
  span = "half",
  ...props
}: TrendChartProps<FundPeriodValues> & {
  colourSource: readonly (FundPeriodValues | null)[];
  /** the period the Share view splits (the selected one) */
  sharePeriod: FundPeriod | null;
}) {
  const breakdown = useMemo(
    () => expenseBreakdown(colourSource),
    [colourSource],
  );
  const spec = useMemo(() => expensesSpec(breakdown), [breakdown]);
  const share = () => {
    const v = sharePeriod?.values ?? null;
    if (!sharePeriod || v === null) {
      return (
        <p className="text-sm text-muted-foreground">
          No figures for this period.
        </p>
      );
    }
    const list = v.expensesByCategory.map((c) => ({
      label: c.category,
      amount: c.amount,
    }));
    const s = shareParts(
      breakdown.map((b) => ({
        key: b.key,
        label: b.label,
        slot: b.slot,
        amount: breakdownValue(list, b.members) ?? 0n,
      })),
    );
    return (
      <SegmentedBar
        caption={
          <>
            Share of expenses in{" "}
            <span className="font-medium text-foreground">
              {periodLabel(sharePeriod.key)}
            </span>
          </>
        }
        parts={s.parts}
        total={s.total}
        totalShare={s.totalShare}
      />
    );
  };
  return (
    <PeriodChart
      id="expenses"
      title="Expenses by category"
      description={`By ${grainOf(props.periods)}, operating and paid from capital.`}
      series={spec.series}
      extras={spec.extras}
      span={span}
      share={share}
      {...props}
    />
  );
}
