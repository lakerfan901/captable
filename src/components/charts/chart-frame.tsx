"use client";

import { createContext, type ReactNode, useContext } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface SegmentOption<K extends string> {
  key: K;
  label: string;
}

/**
 * A row of mutually exclusive buttons in the look of the app's tab list
 * (`TabsList` / `TabsTrigger`): "Chart / Table", "Month / Quarter / …".
 * Plain buttons with `aria-pressed`, so each is a Tab stop and Enter / Space
 * switch it.
 */
export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
  testId,
}: {
  options: readonly SegmentOption<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
  testId?: string;
}) {
  return (
    <fieldset
      aria-label={label}
      data-testid={testId}
      className={cn(
        "m-0 inline-flex min-w-0 items-center justify-center rounded-md border-0 bg-muted p-1 text-muted-foreground",
        size === "sm" ? "h-9" : "h-10",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            data-state={active ? "active" : "inactive"}
            data-option={o.key}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              size === "sm" ? "py-1" : "py-1.5",
              active && "bg-background text-foreground shadow-xs",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * Print mode (04-investor-portal.md 5.9 "PDF", package P17): inside the
 * print layout every chart shows its plot AND its table, without the view
 * switch, and a card is never split across pages.
 */
const ChartPrintContext = createContext(false);

export function ChartPrintMode({ children }: { children: ReactNode }) {
  return (
    <ChartPrintContext.Provider value={true}>
      {children}
    </ChartPrintContext.Provider>
  );
}

/** True inside the print layout. */
export function useChartPrintMode(): boolean {
  return useContext(ChartPrintContext);
}

export type ChartView = "chart" | "table" | "share";

/** Width of a chart card in the dashboard grid (`ChartGrid`). */
export type ChartSpan = "full" | "half" | "third" | "thirdLast";

export const CHART_VIEWS: readonly SegmentOption<ChartView>[] = [
  { key: "chart", label: "Chart" },
  { key: "table", label: "Table" },
];

export const CHART_VIEWS_WITH_SHARE: readonly SegmentOption<ChartView>[] = [
  { key: "chart", label: "Over time" },
  { key: "share", label: "Share" },
  { key: "table", label: "Table" },
];

/**
 * The card around one chart: title, a one-line description, the view switch
 * ("Chart / Table", or "Over time / Share / Table") on the right, and the
 * body. `span` places it in the dashboard grid (`ChartGrid`).
 */
export function ChartFrame({
  id,
  title,
  description,
  views = CHART_VIEWS,
  view,
  onViewChange,
  span = "half",
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  views?: readonly SegmentOption<ChartView>[];
  view: ChartView;
  onViewChange: (v: ChartView) => void;
  span?: ChartSpan;
  children: ReactNode;
}) {
  const print = useChartPrintMode();
  return (
    <Card
      id={`chart-${id}`}
      data-chart={id}
      className={cn(
        "flex min-w-0 flex-col",
        print && "break-inside-avoid",
        span === "full" && "col-span-full",
        span === "half" && "col-span-full @min-[52rem]:col-span-3",
        span === "third" &&
          "col-span-full @min-[52rem]:col-span-3 @min-[72rem]:col-span-2",
        // the last of three thirds: full width where thirds become halves (no orphan)
        span === "thirdLast" && "col-span-full @min-[72rem]:col-span-2",
      )}
    >
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-base font-medium leading-snug sm:text-base">
            {title}
          </h3>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {print ? null : (
          <SegmentedControl
            options={views}
            value={view}
            onChange={onViewChange}
            label={`Show ${title} as`}
            size="sm"
            className="shrink-0"
            testId={`view-${id}`}
          />
        )}
      </CardHeader>
      <CardContent className="mt-auto">{children}</CardContent>
    </Card>
  );
}

/** The dashboard's chart grid: six columns on wide containers, one on narrow ones. */
export function ChartGrid({ children }: { children: ReactNode }) {
  // printed: one chart under the other, the charts starting on a new page
  const print = useChartPrintMode();
  if (print) {
    return (
      <div className="flex break-before-page flex-col gap-6">{children}</div>
    );
  }
  return (
    <div className="@container">
      <div className="grid grid-cols-6 gap-6">{children}</div>
    </div>
  );
}
