"use client";

import { RiArrowLeftLine, RiPrinterLine } from "@remixicon/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChartPrintMode } from "@/components/charts/chart-frame";
import { Button } from "@/components/ui/button";

// The print layout of a dashboard page (04-investor-portal.md 5.9 "PDF",
// 6.3 print routes; package P17). The browser's print dialog ("Save as
// PDF") turns it into a vector PDF of exactly what is on screen.
//
// - Mounted as a direct child of <body> (a portal), so the print stylesheet
//   in globals.css can print it alone: no navigation, header, sidebar or
//   toast. On screen it covers the page as a print preview with a toolbar.
// - Inside it the dashboard components run in print mode (`ChartPrintMode`):
//   no period controls, every chart with its table under it, the charts on
//   their own pages and never split across a page break.
// - A fixed width (700 CSS px, the printable width of A4 and Letter at the
//   margins set in globals.css), so the charts are drawn at the width they
//   print at. Narrower screens draw them narrower; they still print whole.
// - `?autoprint=1` (how the export menu opens it) calls the print dialog
//   once the data is there and every chart has drawn, then drops the flag
//   from the address so a reload does not print again.

const CHART_WAIT_MS = 4_000;

function chartsDrawn(root: HTMLElement): boolean {
  const cards = root.querySelectorAll("[data-chart]");
  for (const card of cards) {
    const plotted = card.querySelector("svg.recharts-surface");
    const empty = card.textContent?.includes("No figures") ?? false;
    if (!plotted && !empty) return false;
  }
  return true;
}

function useAutoPrint(ready: boolean, root: HTMLElement | null) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || root === null || done.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("autoprint") !== "1") return;
    done.current = true;
    params.delete("autoprint");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (chartsDrawn(root) || Date.now() - started > CHART_WAIT_MS) {
        // two frames: the last chart's paint is committed before printing
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.print()),
        );
        return;
      }
      timer = setTimeout(attempt, 100);
    };
    void document.fonts.ready.then(attempt);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [ready, root]);
}

export function PrintLayout({
  company,
  title,
  lines,
  ready,
  backHref,
  children,
}: {
  company: string;
  /** the dashboard page of this layout, with the same view */
  backHref: string;
  /** "Financials", "My investment" */
  title: string;
  /** the period, the published-through date, the source */
  lines: readonly ReactNode[];
  /** the data is loaded and the page is complete */
  ready: boolean;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.setAttribute("data-print-root", "");
    el.setAttribute("data-testid", "print-root");
    document.body.appendChild(el);
    setHost(el);
    return () => {
      el.remove();
    };
  }, []);
  useAutoPrint(ready, host);
  if (host === null) return null;
  return createPortal(
    <div className="min-h-full bg-white text-foreground">
      <div className="sticky top-0 z-10 border-b bg-gray-50 print:hidden">
        <div className="mx-auto flex max-w-[700px] flex-wrap items-center justify-between gap-2 px-4 py-2">
          <p className="text-sm text-muted-foreground">
            Print preview. Choose “Save as PDF” in the print dialog for a PDF.
          </p>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <a href={backHref} data-testid="print-back">
                <RiArrowLeftLine className="mr-1 h-4 w-4" aria-hidden />
                Back to the dashboard
              </a>
            </Button>
            <Button
              size="sm"
              onClick={() => window.print()}
              disabled={!ready}
              data-testid="print-now"
            >
              <RiPrinterLine className="mr-1.5 h-4 w-4" aria-hidden />
              Print
            </Button>
          </div>
        </div>
      </div>
      <main
        className="mx-auto flex w-full max-w-[700px] flex-col gap-6 px-4 py-6"
        data-testid="print-layout"
      >
        <header className="flex flex-col gap-1 border-b pb-4">
          <p className="text-sm font-medium text-muted-foreground">{company}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-2xl">
            {title}
          </h1>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed lines, never reordered
            <p key={i} className="text-sm text-muted-foreground">
              {line}
            </p>
          ))}
        </header>
        <ChartPrintMode>{children}</ChartPrintMode>
      </main>
    </div>,
    host,
  );
}
