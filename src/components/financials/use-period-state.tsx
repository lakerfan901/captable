"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FocusRequest } from "@/components/charts/chart-hit-layer";
import type { ChartActivation } from "@/components/charts/period-chart";
import {
  type PeriodState,
  type PeriodView,
  parsePeriodState,
  serializePeriodState,
  withTrendClick,
} from "./period-state";

/**
 * The dashboard's period state (grain, selected period, comparison, drill),
 * read from and written to the URL query, so a view can be bookmarked and
 * Back in the browser undoes a drill. Writes go through the native History
 * API (`replaceState` for grain, period and comparison, `pushState` for
 * drill-downs), which Next.js feeds into `useSearchParams` WITHOUT a server
 * request: the data is already in the browser and is re-aggregated there
 * (5.9). Other query keys of the page are kept. A page using it must render
 * it inside <Suspense> (Next.js requires that for `useSearchParams`).
 */
export function usePeriodState(): [
  PeriodState,
  (next: PeriodState, opts?: { push?: boolean }) => void,
] {
  const params = useSearchParams();
  const state = useMemo(() => parsePeriodState((k) => params.get(k)), [params]);
  const set = useCallback(
    (next: PeriodState, opts: { push?: boolean } = {}) => {
      const qs = serializePeriodState(
        next,
        new URLSearchParams(window.location.search),
      ).toString();
      const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
      if (opts.push) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [],
  );
  return [state, set];
}

/**
 * Drill-down wiring shared by the dashboards: each chart's click / Enter
 * handler, focus moved to Back after a drill, and focus returned to the
 * drilled period of the same chart after Back.
 */
export function useDrillFocus(
  state: PeriodState,
  view: PeriodView,
  onChange: (next: PeriodState, opts?: { push?: boolean }) => void,
) {
  const backRef = useRef<HTMLButtonElement | null>(null);
  const trail = useRef<{ chartId: string; key: string }[]>([]);
  const [restore, setRestore] = useState<{
    chartId: string;
    request: FocusRequest;
  } | null>(null);
  const pendingBackFocus = useRef(false);

  useEffect(() => {
    if (pendingBackFocus.current && view.drill.length > 0) {
      pendingBackFocus.current = false;
      backRef.current?.focus();
    }
  });

  const activationFor = (chartId: string): ChartActivation | null => {
    if (!view.drillable && !view.pickable) return null;
    return {
      hint: view.drillable
        ? `Click to see its ${view.trendGrain === "year" ? "quarters" : "months"}`
        : "Click to select this month",
      onActivate: (key) => {
        const next = withTrendClick(state, view, key);
        if (view.drillable) {
          trail.current = [
            ...trail.current.slice(0, view.drill.length),
            { chartId, key },
          ];
          pendingBackFocus.current = true;
          onChange(next, { push: true });
        } else {
          onChange(next);
        }
      },
    };
  };

  /** the controls' change handler: Back returns focus to the period it left */
  const onControlsChange = (next: PeriodState, opts?: { push?: boolean }) => {
    if (next.drill.length < view.drill.length && next.grain === state.grain) {
      const left = trail.current[next.drill.length];
      trail.current = trail.current.slice(0, next.drill.length);
      if (left) {
        setRestore({
          chartId: left.chartId,
          request: { key: left.key, token: Date.now() },
        });
      }
    }
    onChange(next, opts);
  };

  const focusFor = (chartId: string): FocusRequest | null =>
    restore?.chartId === chartId ? restore.request : null;

  return { backRef, activationFor, focusFor, onControlsChange };
}
