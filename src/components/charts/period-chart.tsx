"use client";

import { type ReactNode, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
} from "recharts";
import type { AggregatedPeriod } from "@/lib/llc/financial-series";
import { formatTick, type ValueUnit } from "./chart-format";
import {
  CHART_VIEWS,
  CHART_VIEWS_WITH_SHARE,
  ChartFrame,
  type ChartSpan,
  type ChartView,
} from "./chart-frame";
import {
  ChartHitLayer,
  type FocusRequest,
  type HitBand,
} from "./chart-hit-layer";
import { ChartLegend } from "./chart-legend";
import {
  buildPeriodRows,
  type ChartRow,
  type ExtraSpec,
  type SeriesSpec,
  type StackRole,
  slotColor,
  stackRoles,
  tableModel,
  toggleHidden,
  tooltipModel,
  tooltipSentence,
  valueScale,
  visibleSeries,
} from "./chart-model";
import { MoneyAxis, VALUE_AXIS_WIDTH } from "./money-axis";
import { PERIOD_AXIS_HEIGHT, PeriodAxis } from "./period-axis";
import { SeriesTable } from "./series-table";
import { useElementWidth } from "./use-element-width";

const MARGIN_TOP = 10;
const END_LABEL_ROOM = 64;
const MARGIN_RIGHT = 8;

export interface ChartActivation {
  /** tooltip and accessible hint: "Click to see its months" */
  hint: string;
  onActivate: (key: string) => void;
}

/** A bar segment: 4px rounded data-end, square at the baseline, a 2px surface gap under stacked segments. */
function barPath(
  x: number,
  y: number,
  w: number,
  h: number,
  role: StackRole,
  negative: boolean,
): string {
  let top = Math.min(y, y + h);
  let height = Math.abs(h);
  if (role.gap) {
    height -= 2;
    if (negative) top += 2;
  }
  if (height <= 0.5 || w <= 0) return "";
  const r = role.cap ? Math.min(4, w / 2, height) : 0;
  const b = top + height;
  const rgt = x + w;
  if (!negative) {
    return `M${x},${b}V${top + r}Q${x},${top} ${x + r},${top}H${rgt - r}Q${rgt},${top} ${rgt},${top + r}V${b}Z`;
  }
  return `M${x},${top}V${b - r}Q${x},${b} ${x + r},${b}H${rgt - r}Q${rgt},${b} ${rgt},${b - r}V${top}Z`;
}

interface BarShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: { key: string; partial: boolean };
}

/**
 * One period chart: legend (click to hide a series), the Recharts plot with
 * one value axis, the hit layer (hover / focus tooltip, click or Enter to
 * drill), end labels for line series, and the Table (and optional Share)
 * view. Takes aggregated periods (`aggregate` / `aggregateHolder` output) and
 * the series spec; it knows nothing about where the periods came from.
 */
export function PeriodChart<V>({
  id,
  title,
  description,
  periods,
  series,
  extras = [],
  unit,
  span = "half",
  height = 240,
  highlightKey = null,
  activation = null,
  focusRequest = null,
  endLabels = false,
  fixedMax,
  share,
  fadePartial = true,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  periods: readonly AggregatedPeriod<V>[];
  series: readonly SeriesSpec<V>[];
  extras?: readonly ExtraSpec<V>[];
  /** unit of the value axis (default: the first series') */
  unit?: ValueUnit;
  span?: ChartSpan;
  height?: number;
  highlightKey?: string | null;
  activation?: ChartActivation | null;
  focusRequest?: FocusRequest | null;
  endLabels?: boolean;
  /** a fixed top of the value axis (utilization: 10000 = 100%) */
  fixedMax?: number;
  /** the Share view (expenses): rendered when chosen */
  share?: () => ReactNode;
  /** summed bars of a partial period are drawn lighter */
  fadePartial?: boolean;
}) {
  const [view, setView] = useState<ChartView>("chart");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { ref, width } = useElementWidth<HTMLDivElement>();

  const rows = useMemo(
    () => buildPeriodRows(periods, series, extras),
    [periods, series, extras],
  );
  const shown = visibleSeries(series, hidden);
  const axisUnit = unit ?? series[0]?.unit ?? "cents";
  const anyData = rows.some((r) => r.hasData);

  const views = share ? CHART_VIEWS_WITH_SHARE : CHART_VIEWS;
  const toggle = (key: string) =>
    setHidden((h) =>
      toggleHidden(
        h,
        key,
        series.map((s) => s.key),
      ),
    );

  return (
    <ChartFrame
      id={id}
      title={title}
      description={description}
      views={views}
      view={view}
      onViewChange={setView}
      span={span}
    >
      {view === "share" && share ? (
        share()
      ) : view === "table" ? (
        <SeriesTable
          model={tableModel(rows, series, extras)}
          caption={title}
          testId={`table-${id}`}
        />
      ) : (
        <>
          <ChartLegend
            chartId={id}
            items={series.map((s) => ({
              key: s.key,
              label: s.label,
              slot: s.slot,
              mark: s.mark,
            }))}
            hidden={hidden}
            onToggle={toggle}
          />
          <div ref={ref} className="relative w-full" style={{ height }}>
            {!anyData ? (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No figures for these periods.
              </p>
            ) : width > 0 ? (
              <PlotBody
                id={id}
                title={title}
                rows={rows}
                series={series}
                shown={shown}
                extras={extras}
                unit={axisUnit}
                width={width}
                height={height}
                highlightKey={highlightKey}
                activation={activation}
                focusRequest={focusRequest}
                endLabels={endLabels}
                fixedMax={fixedMax}
                fadePartial={fadePartial}
              />
            ) : null}
          </div>
        </>
      )}
    </ChartFrame>
  );
}

function PlotBody<V>({
  id,
  title,
  rows,
  series,
  shown,
  extras,
  unit,
  width,
  height,
  highlightKey,
  activation,
  focusRequest,
  endLabels,
  fixedMax,
  fadePartial,
}: {
  id: string;
  title: string;
  rows: ChartRow[];
  series: readonly SeriesSpec<V>[];
  shown: readonly SeriesSpec<V>[];
  extras: readonly ExtraSpec<V>[];
  unit: ValueUnit;
  width: number;
  height: number;
  highlightKey: string | null;
  activation: ChartActivation | null;
  focusRequest: FocusRequest | null;
  endLabels: boolean;
  fixedMax?: number;
  fadePartial: boolean;
}) {
  const marginRight = endLabels ? END_LABEL_ROOM : MARGIN_RIGHT;
  const plotLeft = VALUE_AXIS_WIDTH;
  const plotWidth = Math.max(40, width - plotLeft - marginRight);
  const plotHeight = height - MARGIN_TOP - PERIOD_AXIS_HEIGHT;
  const n = rows.length;

  // data keys by the series' index in the full list: stable when a series is hidden
  const dk = (s: SeriesSpec<V>) => `s${series.indexOf(s)}`;
  const data = rows.map((r) => {
    const d: Record<string, unknown> = { key: r.key, partial: r.partial };
    for (const s of shown) d[dk(s)] = r.plot[s.key] ?? null;
    return d;
  });

  const stacked = shown.filter(
    (s) => s.stack !== undefined && s.mark !== "line",
  );
  const scale = valueScale(rows, shown, fixedMax);
  const yOf = (v: number) =>
    MARGIN_TOP + ((scale.max - v) / (scale.max - scale.min || 1)) * plotHeight;

  const roles = stackRoles(
    rows,
    stacked.filter((s) => s.mark === "bar"),
  );
  const labels = new Map(rows.map((r) => [r.key, r.short]));
  const bars = shown.filter((s) => s.mark === "bar");

  const shape = (s: SeriesSpec<V>) => (p: BarShapeProps) => {
    const role: StackRole =
      s.stack !== undefined
        ? (roles.get(p.payload?.key ?? "")?.[s.key] ?? {
            cap: true,
            gap: false,
          })
        : { cap: true, gap: false };
    const raw = p.payload
      ? rows.find((r) => r.key === p.payload?.key)?.plot[s.key]
      : null;
    const d = barPath(
      p.x ?? 0,
      p.y ?? 0,
      p.width ?? 0,
      p.height ?? 0,
      role,
      (raw ?? 0) < 0,
    );
    if (!d) return <g />;
    const faded = fadePartial && s.rule === "sum" && p.payload?.partial;
    return (
      <path d={d} fill={slotColor(s.slot)} fillOpacity={faded ? 0.45 : 1} />
    );
  };

  const hi = highlightKey ? rows.findIndex((r) => r.key === highlightKey) : -1;
  const bw = plotWidth / Math.max(1, n);

  const bands: HitBand[] = rows.map((r) => {
    const t = tooltipModel(r, shown, extras);
    return {
      key: r.key,
      label: tooltipSentence(t),
      tooltip: t,
      activatable: activation !== null && r.hasData,
    };
  });

  // end labels: the last value of each line series, dropped (not nudged) when two collide
  const ends: { key: string; y: number; text: string }[] = [];
  if (endLabels) {
    const last = rows[n - 1];
    for (const s of shown) {
      if (s.mark !== "line" && !(s.mark === "area" && s.stack === undefined))
        continue;
      const v = last?.plot[s.key] ?? null;
      if (v === null) continue;
      const y = yOf(v);
      if (ends.some((e) => Math.abs(e.y - y) < 14)) continue;
      ends.push({ key: s.key, y, text: formatTick(unit, v) });
    }
  }

  return (
    <>
      {hi >= 0 ? (
        <div
          aria-hidden="true"
          className="absolute rounded-sm bg-muted"
          style={{
            left: plotLeft + bw * hi,
            width: bw,
            top: MARGIN_TOP,
            height: plotHeight,
          }}
        />
      ) : null}
      <div aria-hidden="true" className="relative">
        <ComposedChart
          width={width}
          height={height}
          data={data}
          margin={{ top: MARGIN_TOP, right: marginRight, bottom: 0, left: 0 }}
          accessibilityLayer={false}
          stackOffset="sign"
          barGap={2}
          barCategoryGap={
            bars.length > 1 && stacked.length === 0 ? "22%" : "30%"
          }
        >
          <CartesianGrid
            vertical={false}
            stroke="hsl(var(--border))"
            strokeWidth={1}
          />
          <PeriodAxis
            labels={labels}
            highlightKey={highlightKey}
            plotWidth={plotWidth}
          />
          <MoneyAxis scale={scale} unit={unit} />
          {scale.min < 0 ? (
            <ReferenceLine
              y={0}
              stroke="hsl(var(--muted-foreground))"
              strokeOpacity={0.5}
            />
          ) : null}
          {shown.map((s) => {
            const color = slotColor(s.slot);
            if (s.mark === "bar") {
              return (
                <Bar
                  key={s.key}
                  dataKey={dk(s)}
                  name={s.label}
                  stackId={s.stack}
                  fill={color}
                  maxBarSize={24}
                  isAnimationActive={false}
                  shape={shape(s)}
                />
              );
            }
            if (s.mark === "area") {
              return (
                <Area
                  key={s.key}
                  dataKey={dk(s)}
                  name={s.label}
                  stackId={s.stack}
                  type="linear"
                  stroke={color}
                  strokeWidth={2}
                  fill={color}
                  fillOpacity={0.1}
                  connectNulls={false}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
              );
            }
            return (
              <Line
                key={s.key}
                dataKey={dk(s)}
                name={s.label}
                type="linear"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                connectNulls={false}
                dot={
                  n <= 16
                    ? {
                        r: 4,
                        fill: color,
                        stroke: "hsl(var(--card))",
                        strokeWidth: 2,
                      }
                    : false
                }
                activeDot={false}
                isAnimationActive={false}
              />
            );
          })}
        </ComposedChart>
      </div>
      {ends.map((e) => (
        <span
          key={e.key}
          aria-hidden="true"
          className="pointer-events-none absolute text-xs font-semibold tabular-nums text-foreground"
          style={{ left: plotLeft + plotWidth + 8, top: e.y - 8 }}
        >
          {e.text}
        </span>
      ))}
      <ChartHitLayer
        chartId={id}
        title={title}
        bands={bands}
        left={plotLeft}
        width={plotWidth}
        top={0}
        height={height}
        hint={activation?.hint}
        onActivate={activation?.onActivate}
        focusRequest={focusRequest}
        initialKey={highlightKey}
      />
    </>
  );
}
