"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine } from "recharts";
import {
  formatValue,
  niceScale,
  plotNumber,
} from "@/components/charts/chart-format";
import {
  ChartFrame,
  type ChartSpan,
  type ChartView,
} from "@/components/charts/chart-frame";
import {
  ChartHitLayer,
  type HitBand,
} from "@/components/charts/chart-hit-layer";
import { ChartLegend } from "@/components/charts/chart-legend";
import {
  periodRowLabel,
  slotColor,
  type TooltipModel,
  tooltipSentence,
  type WaterfallKind,
} from "@/components/charts/chart-model";
import { MoneyAxis, VALUE_AXIS_WIDTH } from "@/components/charts/money-axis";
import { PeriodAxis } from "@/components/charts/period-axis";
import { SeriesTable } from "@/components/charts/series-table";
import { useElementWidth } from "@/components/charts/use-element-width";
import type { FundPeriod } from "@/lib/llc/financial-series";
import {
  cashFlowSteps,
  cashFlowView,
  CASH_FLOW_KIND_LABEL as KIND_LABEL,
  CASH_FLOW_KIND_SLOT as KIND_SLOT,
} from "./dashboard-model";

const SHORT: Record<string, string> = {
  grossRevenue: "Revenue",
  otherIncome: "Other income",
  proceeds: "Proceeds",
  operatingExpenses: "Expenses",
  managementFeePaid: "Fee",
  reservesEstablished: "Set aside",
  reservesReleased: "Released",
  distributions: "Distributions",
  other: "Other",
  change: "Change",
};

const HEIGHT = 260;
const TOP = 10;

/**
 * F3: where the money of one period went, as a waterfall from the Available
 * Cash at the end of the previous period: revenue, other income, proceeds,
 * operating expenses, Management Fee paid, reserves set aside and released,
 * distributions, then "Other movements" (what those lines do not explain:
 * spending paid from capital, member loans, timing) so the steps add up
 * exactly, and the change in Available Cash. Bars span from the running total
 * before the step to the one after it.
 */
export function CashFlowChart({
  period,
  opening,
  span = "half",
}: {
  /** the selected period (aggregated) */
  period: FundPeriod | null;
  /** Available Cash at the end of the previous period; 0 before inception; null when unknown */
  opening: bigint | null;
  span?: ChartSpan;
}) {
  const [view, setView] = useState<ChartView>("chart");
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const v = period?.values ?? null;
  const steps = v !== null && opening !== null ? cashFlowSteps(v, opening) : [];
  const title = "Cash flow of the period";
  const label = period ? periodRowLabel(period) : "";

  const { tooltips, table } = cashFlowView(steps, label);
  const tip = (i: number): TooltipModel =>
    tooltips[i] ?? {
      title: "",
      note: null,
      lines: [],
      total: null,
      extras: [],
    };

  const description =
    v !== null && opening !== null
      ? `${label}: Available Cash from ${formatValue("cents", opening)} to ${formatValue("cents", v.availableCash)}.`
      : "Available Cash at the start of the period is not available.";

  return (
    <ChartFrame
      id="cash-flow"
      title={title}
      description={description}
      view={view}
      onViewChange={setView}
      span={span}
    >
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No figures for this period.
        </p>
      ) : view === "table" ? (
        <SeriesTable
          model={table}
          firstColumn="Step"
          caption={`${title}, ${label}`}
          testId="table-cash-flow"
        />
      ) : (
        <>
          <ChartLegend
            chartId="cash-flow"
            items={(["in", "out", "total"] as const).map((k) => ({
              key: k,
              label: KIND_LABEL[k],
              slot: KIND_SLOT[k],
              mark: "bar",
            }))}
          />
          <div ref={ref} className="relative w-full" style={{ height: HEIGHT }}>
            {width > 0 ? (
              <Waterfall steps={steps} width={width} tip={tip} />
            ) : null}
          </div>
        </>
      )}
    </ChartFrame>
  );
}

function Waterfall({
  steps,
  width,
  tip,
}: {
  steps: ReturnType<typeof cashFlowSteps>;
  width: number;
  tip: (i: number) => TooltipModel;
}) {
  const plotWidth = Math.max(40, width - VALUE_AXIS_WIDTH - 8);
  const data = steps.map((s) => {
    const a = plotNumber(s.from) ?? 0;
    const b = plotNumber(s.to) ?? 0;
    return {
      key: s.key,
      kind: s.kind,
      range: [Math.min(a, b), Math.max(a, b)],
    };
  });
  const scale = niceScale(data.flatMap((d) => d.range));
  const labels = new Map(steps.map((s) => [s.key, SHORT[s.key] ?? s.label]));
  const bands: HitBand[] = steps.map((s, i) => {
    const t = tip(i);
    return {
      key: s.key,
      label: tooltipSentence(t),
      tooltip: t,
      activatable: false,
    };
  });
  return (
    <>
      <div aria-hidden="true">
        <BarChart
          width={width}
          height={HEIGHT}
          data={data}
          margin={{ top: TOP, right: 8, bottom: 0, left: 0 }}
          accessibilityLayer={false}
          barCategoryGap="24%"
        >
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <PeriodAxis
            labels={labels}
            highlightKey={null}
            plotWidth={plotWidth}
          />
          <MoneyAxis scale={scale} />
          {scale.min < 0 ? (
            <ReferenceLine
              y={0}
              stroke="hsl(var(--muted-foreground))"
              strokeOpacity={0.5}
            />
          ) : null}
          <Bar
            dataKey="range"
            maxBarSize={24}
            isAnimationActive={false}
            shape={(p: {
              x?: number;
              y?: number;
              width?: number;
              height?: number;
              payload?: { kind: WaterfallKind };
            }) => {
              const h = Math.max(1, Math.abs(p.height ?? 0));
              const y = Math.min(p.y ?? 0, (p.y ?? 0) + (p.height ?? 0));
              return (
                <rect
                  x={p.x}
                  y={y}
                  width={p.width}
                  height={h}
                  rx={2}
                  fill={slotColor(KIND_SLOT[p.payload?.kind ?? "in"])}
                />
              );
            }}
          />
        </BarChart>
      </div>
      <ChartHitLayer
        chartId="cash-flow"
        title="Cash flow of the period"
        bands={bands}
        left={VALUE_AXIS_WIDTH}
        width={plotWidth}
        top={0}
        height={HEIGHT}
      />
    </>
  );
}
