"use client";

import { type ReactNode, useMemo } from "react";
import { formatDate } from "@/components/charts/chart-format";
import { ChartGrid, useChartPrintMode } from "@/components/charts/chart-frame";
import { partialOf } from "@/components/charts/chart-model";
import { compareIso, type IsoDate } from "@/lib/llc/dates";
import {
  addMonthKeys,
  type MonthKey,
  monthEnd,
  monthOf,
  periodLabel,
} from "@/lib/llc/financial-periods";
import {
  aggregate,
  type FundMonth,
  fundComparison,
} from "@/lib/llc/financial-series";
import { CapitalChart } from "./capital-chart";
import { CashFlowChart } from "./cash-flow-chart";
import { hasUtilization } from "./chart-specs";
import { NoPeriods, PeriodHeading } from "./dashboard-header";
import { FUND_TILES, type TileView, tileViews } from "./dashboard-model";
import { DistributionsChart } from "./distributions-chart";
import { ExpensesChart } from "./expenses-chart";
import { KpiGrid, KpiTile } from "./kpi-tile";
import { PeriodControls } from "./period-controls";
import { monthsUntil, type PeriodState, resolveView } from "./period-state";
import { PreferredReturnChart } from "./preferred-return-chart";
import { ReservesChart } from "./reserves-chart";
import { RevenueChart } from "./revenue-chart";
import { useDrillFocus } from "./use-period-state";
import { UtilizationChart } from "./utilization-chart";

export interface FundDashboardProps {
  /**
   * Every fund month the viewer may see, from inception (the investor's
   * snapshots through the published-through date, or the team's live
   * months). Aggregated here with P12's `aggregate`; never fetched here.
   */
  fundMonths: readonly FundMonth[];
  /** first month of the fund (default: the first record) */
  inceptionMonth?: MonthKey;
  state: PeriodState;
  onStateChange: (next: PeriodState, opts?: { push?: boolean }) => void;
  /** restated months (P35): `{ month, at }` */
  restatements?: readonly { month: MonthKey; at: IsoDate }[];
  /** the Target Sale Date, for the "months to the Target Sale Date" tile */
  targetSaleDate?: IsoDate | null;
  /** right side of the control row (export menu: P17) */
  actions?: ReactNode;
}

/**
 * The fund view ("Financials", 5.9 and 6.3): period control, KPI tiles of
 * the selected period with the change against the comparison period, and
 * charts F1–F8 over the trend of periods around it. Fund-level figures only:
 * no holder appears here (P36).
 */
export function FundDashboard({
  fundMonths,
  inceptionMonth,
  state,
  onStateChange,
  restatements = [],
  targetSaleDate = null,
  actions,
}: FundDashboardProps) {
  const sorted = useMemo(
    () => [...fundMonths].sort((a, b) => compareIso(a.month, b.month)),
    [fundMonths],
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return <NoPeriods />;
  return (
    <FundDashboardBody
      months={sorted}
      inception={inceptionMonth ?? first.month}
      last={last.month}
      state={state}
      onStateChange={onStateChange}
      restatements={restatements}
      targetSaleDate={targetSaleDate}
      actions={actions}
    />
  );
}

function FundDashboardBody({
  months,
  inception,
  last,
  state,
  onStateChange,
  restatements,
  targetSaleDate,
  actions,
}: {
  months: FundMonth[];
  inception: MonthKey;
  last: MonthKey;
  state: PeriodState;
  onStateChange: FundDashboardProps["onStateChange"];
  restatements: readonly { month: MonthKey; at: IsoDate }[];
  targetSaleDate: IsoDate | null;
  actions?: ReactNode;
}) {
  const opts = { inceptionMonth: inception };
  const print = useChartPrintMode();
  const view = resolveView(state, { inception, last });
  const { backRef, activationFor, focusFor, onControlsChange } = useDrillFocus(
    state,
    view,
    onStateChange,
  );

  const { trendGrain } = view;
  const { from: trendFrom, to: trendTo } = view.trendRange;
  const trend = useMemo(
    () =>
      aggregate(
        months,
        trendGrain,
        { from: trendFrom, to: trendTo },
        { inceptionMonth: inception },
      ),
    [months, trendGrain, trendFrom, trendTo, inception],
  );
  const focus = aggregate(months, view.focus.grain, view.focusRange, opts)[0];
  // colours of the breakdowns follow the label over every month (not the window)
  const allMonths = useMemo(
    () =>
      aggregate(
        months,
        "month",
        { from: inception, to: last },
        { inceptionMonth: inception },
      ).map((p) => p.values),
    [months, inception, last],
  );
  if (!focus) return null;

  const comparison =
    view.comparison && state.compare !== "none"
      ? fundComparison(months, view.focus, state.compare, opts)
      : null;
  const comparisonLabel = view.comparison
    ? periodLabel(view.comparison.key)
    : null;

  const showUtilization = hasUtilization(months);
  const defs = FUND_TILES.filter(
    (d) => d.key !== "utilizationBps" || showUtilization,
  );
  const tiles: TileView[] = tileViews(
    defs,
    focus,
    comparison,
    comparisonLabel,
    trend,
  );
  if (targetSaleDate) {
    const lastMonth =
      focus.presentMonths[focus.presentMonths.length - 1] ?? last;
    const n = monthsUntil(lastMonth, monthOf(targetSaleDate));
    tiles.push({
      key: "targetSale",
      label: "Months to the Target Sale Date",
      value: String(n),
      sub: `Target Sale Date ${formatDate(targetSaleDate)}`,
      delta: null,
      deltaNote: null,
      spark: [],
    });
  }

  const part = partialOf(focus);
  const partialNote =
    part && focus.grain !== "inception"
      ? `${part.note}, so it is not compared with a full ${focus.grain}.`
      : null;

  const restatedOn = [
    ...new Set(
      restatements
        .filter((r) => focus.presentMonths.includes(r.month))
        .map((r) => r.at),
    ),
  ];

  // F3 opens at the Available Cash of the month before the period
  const before = addMonthKeys(view.focusRange.from, -1);
  const opening =
    compareIso(view.focusRange.from, inception) <= 0
      ? 0n
      : (months.find((m) => m.month === before)?.availableCash ?? null);

  const common = (id: string) => ({
    periods: trend,
    highlightKey: view.highlightKey,
    activation: activationFor(id),
    focusRequest: focusFor(id),
  });

  return (
    <div className="flex flex-col gap-6" data-testid="fund-dashboard">
      {print ? (
        partialNote ? (
          <p className="text-sm text-muted-foreground">{partialNote}</p>
        ) : null
      ) : (
        <PeriodControls
          ref={backRef}
          state={state}
          view={view}
          onChange={onControlsChange}
          partialNote={partialNote}
          actions={actions}
        />
      )}
      <PeriodHeading period={focus} restatedOn={restatedOn} />
      <KpiGrid columns={tiles.length > 10 ? 4 : 5}>
        {tiles.map((t) => (
          <KpiTile key={t.key} tile={t} />
        ))}
      </KpiGrid>
      <ChartGrid>
        <RevenueChart {...common("revenue")} />
        <ExpensesChart
          {...common("expenses")}
          colourSource={allMonths}
          sharePeriod={focus}
        />
        <DistributionsChart {...common("distributions")} />
        <CapitalChart {...common("capital")} />
        <PreferredReturnChart {...common("preferred-return")} />
        <ReservesChart
          {...common("reserves")}
          colourSource={allMonths}
          span="thirdLast"
        />
        <CashFlowChart
          period={focus}
          opening={opening}
          span={showUtilization ? "half" : "full"}
        />
        <UtilizationChart
          {...common("utilization")}
          months={months}
          span="half"
        />
      </ChartGrid>
      <p className="text-xs text-muted-foreground">
        Figures through {formatDate(monthEnd(last))}. Periods without figures
        are shown as gaps.
      </p>
    </div>
  );
}
