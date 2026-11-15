"use client";

import { type ReactNode, useMemo } from "react";
import { ChartGrid } from "@/components/charts/chart-frame";
import { partialOf } from "@/components/charts/chart-model";
import { compareIso, type IsoDate } from "@/lib/llc/dates";
import { type MonthKey, periodLabel } from "@/lib/llc/financial-periods";
import {
  aggregateHolder,
  type FundMonth,
  type HolderMonth,
  holderComparison,
} from "@/lib/llc/financial-series";
import { NoPeriods, PeriodHeading } from "./dashboard-header";
import { HOLDER_TILES, tileViews, unitsTile } from "./dashboard-model";
import { KpiGrid, KpiTile } from "./kpi-tile";
import { MyCapitalChart } from "./my-capital-chart";
import { MyDistributionsChart } from "./my-distributions-chart";
import { PeriodControls } from "./period-controls";
import { type PeriodState, resolveView } from "./period-state";
import { useDrillFocus } from "./use-period-state";

export interface InvestmentDashboardProps {
  /** the holder's own month records (one holder only, P36), from its first */
  holderMonths: readonly HolderMonth[];
  /** the fund calendar: the months that exist for the viewer */
  fundMonths: readonly Pick<FundMonth, "month" | "inProgress">[];
  inceptionMonth?: MonthKey;
  state: PeriodState;
  onStateChange: (next: PeriodState, opts?: { push?: boolean }) => void;
  restatements?: readonly { month: MonthKey; at: IsoDate }[];
  actions?: ReactNode;
}

/**
 * The holder's own view ("My investment", 5.9 and 6.3): the same period
 * control, "my" KPI tiles and charts M1 and M2. Takes one holder's records
 * only; a month of the calendar without a record of the holder counts as no
 * position and no movement (P12 `aggregateHolder`).
 */
export function InvestmentDashboard({
  holderMonths,
  fundMonths,
  inceptionMonth,
  state,
  onStateChange,
  restatements = [],
  actions,
}: InvestmentDashboardProps) {
  const calendar = useMemo(
    () => [...fundMonths].sort((a, b) => compareIso(a.month, b.month)),
    [fundMonths],
  );
  const first = calendar[0];
  const last = calendar[calendar.length - 1];
  if (!first || !last) return <NoPeriods />;
  return (
    <Body
      holderMonths={holderMonths}
      calendar={calendar}
      inception={inceptionMonth ?? first.month}
      last={last.month}
      state={state}
      onStateChange={onStateChange}
      restatements={restatements}
      actions={actions}
    />
  );
}

function Body({
  holderMonths,
  calendar,
  inception,
  last,
  state,
  onStateChange,
  restatements,
  actions,
}: {
  holderMonths: readonly HolderMonth[];
  calendar: Pick<FundMonth, "month" | "inProgress">[];
  inception: MonthKey;
  last: MonthKey;
  state: PeriodState;
  onStateChange: InvestmentDashboardProps["onStateChange"];
  restatements: readonly { month: MonthKey; at: IsoDate }[];
  actions?: ReactNode;
}) {
  const opts = { inceptionMonth: inception };
  const view = resolveView(state, { inception, last });
  const { backRef, activationFor, focusFor, onControlsChange } = useDrillFocus(
    state,
    view,
    onStateChange,
  );
  const trend = aggregateHolder(
    holderMonths,
    calendar,
    view.trendGrain,
    view.trendRange,
    opts,
  );
  const focus = aggregateHolder(
    holderMonths,
    calendar,
    view.focus.grain,
    view.focusRange,
    opts,
  )[0];
  if (!focus) return null;

  const comparison =
    view.comparison && state.compare !== "none"
      ? holderComparison(
          holderMonths,
          calendar,
          view.focus,
          state.compare,
          opts,
        )
      : null;
  const comparisonLabel = view.comparison
    ? periodLabel(view.comparison.key)
    : null;

  // before the holder's first record there is no position to show
  const firstOwn = [...holderMonths].sort((a, b) =>
    compareIso(a.month, b.month),
  )[0];
  const lastOfFocus = focus.presentMonths[focus.presentMonths.length - 1];
  const before =
    !firstOwn ||
    (lastOfFocus !== undefined && compareIso(lastOfFocus, firstOwn.month) < 0);

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
  const tiles = tileViews(
    HOLDER_TILES,
    focus,
    comparison,
    comparisonLabel,
    trend,
  );
  const common = (id: string) => ({
    periods: trend,
    highlightKey: view.highlightKey,
    activation: activationFor(id),
    focusRequest: focusFor(id),
  });

  return (
    <div className="flex flex-col gap-6" data-testid="investment-dashboard">
      <PeriodControls
        ref={backRef}
        state={state}
        view={view}
        onChange={onControlsChange}
        partialNote={partialNote}
        actions={actions}
      />
      <PeriodHeading period={focus} restatedOn={restatedOn} />
      {before || focus.values === null ? (
        <div
          className="rounded-lg border p-6 text-sm"
          data-testid="no-position"
        >
          <p className="font-medium">
            No position in {periodLabel(focus.key)}.
          </p>
          <p className="mt-1 text-muted-foreground">
            {firstOwn
              ? `Your figures start in ${periodLabel(firstOwn.month.slice(0, 7))}. Pick a later period.`
              : "There are no figures for you in the published periods yet."}
          </p>
        </div>
      ) : (
        <>
          <KpiGrid columns={4}>
            {tiles.slice(0, 2).map((t) => (
              <KpiTile key={t.key} tile={t} />
            ))}
            <KpiTile tile={unitsTile(focus.values)} />
            {tiles.slice(2).map((t) => (
              <KpiTile key={t.key} tile={t} />
            ))}
          </KpiGrid>
          <ChartGrid>
            <MyDistributionsChart {...common("my-distributions")} />
            <MyCapitalChart {...common("my-capital")} span="full" />
          </ChartGrid>
        </>
      )}
    </div>
  );
}
