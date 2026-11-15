"use client";

import {
  RiArrowLeftLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
} from "@remixicon/react";
import { forwardRef, type ReactNode } from "react";
import { SegmentedControl } from "@/components/charts/chart-frame";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { periodLabel } from "@/lib/llc/financial-periods";
import {
  COMPARE_MODES,
  type CompareMode,
  compareOptionLabel,
  GRAIN_OPTIONS,
  type PeriodState,
  type PeriodView,
  withBack,
  withCompare,
  withGrain,
  withPeriod,
} from "./period-state";

/**
 * The period control of the dashboard (one row above everything it scopes):
 * grain (Month / Quarter / Year / Since inception), previous / next and the
 * period list, the comparison, and an actions slot on the right. When the
 * charts are drilled into a period, a second row shows Back and what is
 * shown. A partial period says it is not compared.
 */
export const PeriodControls = forwardRef<
  HTMLButtonElement,
  {
    state: PeriodState;
    view: PeriodView;
    onChange: (next: PeriodState, opts?: { push?: boolean }) => void;
    /** why the selected period is not compared ("2 of 3 months so far"), or null */
    partialNote: string | null;
    actions?: ReactNode;
  }
>(function PeriodControls(
  { state, view, onChange, partialNote, actions },
  backRef,
) {
  const latestFirst = [...view.periods].reverse();
  const selected = view.periods[view.selectedIndex];
  const canCompare = view.focus.grain !== "inception";
  return (
    <div className="flex flex-col gap-3" data-testid="period-controls">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <SegmentedControl
          options={GRAIN_OPTIONS.map((g) => ({ key: g.grain, label: g.label }))}
          value={state.grain}
          onChange={(g) => onChange(withGrain(state, g))}
          label="Break down by"
          testId="grain"
        />
        {view.showPicker && selected ? (
          <div className="flex items-center gap-1">
            {view.prevKey ? (
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                aria-label={`Previous period: ${periodLabel(view.prevKey)}`}
                data-testid="period-prev"
                onClick={() =>
                  view.prevKey &&
                  onChange(withPeriod(state, view, view.prevKey))
                }
              >
                <RiArrowLeftSLine className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : null}
            <Select
              value={selected.key}
              onValueChange={(k) => onChange(withPeriod(state, view, k))}
            >
              <SelectTrigger
                className="w-40"
                aria-label="Period"
                data-testid="period-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {latestFirst.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {periodLabel(p.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {view.nextKey ? (
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                aria-label={`Next period: ${periodLabel(view.nextKey)}`}
                data-testid="period-next"
                onClick={() =>
                  view.nextKey &&
                  onChange(withPeriod(state, view, view.nextKey))
                }
              >
                <RiArrowRightSLine className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ) : null}
        {partialNote ? (
          <span
            className="text-sm text-muted-foreground"
            data-testid="partial-note"
          >
            {partialNote}
          </span>
        ) : canCompare ? (
          <Select
            value={state.compare}
            onValueChange={(c) =>
              onChange(withCompare(state, c as CompareMode))
            }
          >
            <SelectTrigger
              className="w-auto min-w-56 gap-2"
              aria-label="Comparison"
              data-testid="compare-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPARE_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m === "none"
                    ? "Don’t compare"
                    : `Compare to ${compareOptionLabel(view, m)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <span className="grow" />
        {actions}
      </div>
      {view.drillCaption ? (
        <div
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="drill-crumb"
        >
          <Button
            ref={backRef}
            variant="outline"
            size="sm"
            data-testid="drill-back"
            onClick={() => onChange(withBack(state, view))}
          >
            <RiArrowLeftLine className="h-4 w-4" aria-hidden="true" />
            Back
          </Button>
          <span className="text-muted-foreground">
            Showing {view.drillCaption.replace(/ of (.*)$/, " of ")}
            <span className="font-medium text-foreground">
              {view.drillCaption.replace(/^.* of /, "")}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
});
