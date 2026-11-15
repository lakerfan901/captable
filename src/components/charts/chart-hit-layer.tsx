"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { TooltipModel } from "./chart-model";
import { ChartTooltip } from "./chart-tooltip";

/** Ask a chart to focus one of its bands; a new token asks again. */
export interface FocusRequest {
  key: string;
  token: number;
}

export interface HitBand {
  key: string;
  /** the accessible name: the tooltip as one sentence */
  label: string;
  tooltip: TooltipModel;
  /** clicking (or Enter / Space) does something: drill or select */
  activatable: boolean;
}

/**
 * One transparent, focusable target per band of a chart, laid over the plot
 * (the band includes the axis label under it, so it is far bigger than any
 * mark). Pointer or keyboard focus shows the tooltip; click, Enter or Space
 * activates (drill into the period, or select it). The group is one Tab stop
 * (roving tabindex): ←/→ move between periods, Home / End jump to the ends.
 *
 * The layer is HTML over the SVG rather than Recharts' own accessibility
 * layer, which offers arrow keys and a tooltip but no activation.
 */
export function ChartHitLayer({
  chartId,
  title,
  bands,
  left,
  width,
  top,
  height,
  hint,
  onActivate,
  focusRequest,
  initialKey = null,
}: {
  chartId: string;
  title: string;
  bands: readonly HitBand[];
  left: number;
  width: number;
  top: number;
  height: number;
  /** tooltip line for activatable bands ("Click to see its months") */
  hint?: string;
  onActivate?: (key: string) => void;
  /** focus this band once per token (focus returns here after Back) */
  focusRequest?: FocusRequest | null;
  /** the band that takes the Tab stop first (the selected period), else the last */
  initialKey?: string | null;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [pointerY, setPointerY] = useState<number | null>(null);
  const initial = bands.findIndex((b) => b.key === initialKey);
  const [rover, setRover] = useState(
    initial >= 0 ? initial : Math.max(0, bands.length - 1),
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = bands.length;
  const bw = n > 0 ? width / n : 0;

  // a new set of bands (another grain, a drill) starts at the selected one again
  const bandKeys = bands.map((b) => b.key).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the bands change
  useEffect(() => {
    setRover(initial >= 0 ? initial : Math.max(0, n - 1));
  }, [bandKeys]);

  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || handled.current === focusRequest.token) return;
    const i = bands.findIndex((b) => b.key === focusRequest.key);
    if (i < 0) return;
    handled.current = focusRequest.token;
    setRover(i);
    refs.current[i]?.focus();
  }, [focusRequest, bands]);

  const move = (to: number) => {
    const i = Math.max(0, Math.min(n - 1, to));
    setRover(i);
    refs.current[i]?.focus();
  };

  const shown = active === null ? null : bands[active];
  const centre = active === null ? 0 : left + bw * (active + 0.5);
  const onRight = centre < left + width / 2;
  const tipStyle: React.CSSProperties = {
    top: Math.max(0, (pointerY ?? top + 8) - 8),
    ...(onRight
      ? { left: centre + Math.min(bw / 2, 24) + 4 }
      : { right: `calc(100% - ${centre - Math.min(bw / 2, 24) - 4}px)` }),
  };

  return (
    <>
      <fieldset
        aria-label={`${title}: one button per period`}
        className="absolute m-0 min-w-0 border-0 p-0"
        style={{ left, top, width, height }}
        data-testid={`hits-${chartId}`}
        onPointerLeave={() => {
          setActive(null);
          setPointerY(null);
        }}
      >
        {bands.map((b, i) => (
          <button
            key={b.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            tabIndex={i === rover ? 0 : -1}
            aria-label={b.activatable && hint ? `${b.label}. ${hint}` : b.label}
            aria-disabled={b.activatable ? undefined : true}
            data-band={b.key}
            className={cn(
              "absolute top-0 h-full rounded-sm outline-hidden hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
              b.activatable ? "cursor-pointer" : "cursor-default",
            )}
            style={{ left: bw * i, width: bw }}
            onPointerMove={(e) => {
              setActive(i);
              const box =
                e.currentTarget.parentElement?.getBoundingClientRect();
              setPointerY(box ? e.clientY - box.top + top : null);
            }}
            onFocus={() => {
              setRover(i);
              setActive(i);
              setPointerY(null);
            }}
            onBlur={() => setActive(null)}
            onClick={() => {
              if (b.activatable && onActivate) onActivate(b.key);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                move(i + 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                move(i - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(n - 1);
              } else if (e.key === "Escape") {
                setActive(null);
              }
            }}
          />
        ))}
      </fieldset>
      {shown ? (
        <ChartTooltip
          model={shown.tooltip}
          hint={shown.activatable ? hint : null}
          style={tipStyle}
        />
      ) : null}
    </>
  );
}
