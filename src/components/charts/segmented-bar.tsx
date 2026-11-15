"use client";

import { useState } from "react";
import { SeriesKey } from "./chart-legend";
import { type ChartSlot, type SharePart, slotColor } from "./chart-model";

/** Fills on which the label inside is near-black (the light hues), else white. */
const DARK_INK: ReadonlySet<ChartSlot> = new Set([4]);

/**
 * One whole split into parts (the tall segmented bar of the dataviz method):
 * widths proportional to the amounts, the share printed inside when it fits,
 * each part focusable with its name, amount and share; a list under it
 * repeats every part with its amount and share and the total.
 */
export function SegmentedBar({
  caption,
  parts,
  total,
  totalShare,
}: {
  caption: React.ReactNode;
  parts: readonly SharePart[];
  total: string;
  /** null when a negative part makes the shares not add up to the total */
  totalShare: string | null;
}) {
  const [active, setActive] = useState<string | null>(null);
  const drawn = parts.filter((p) => p.width > 0);
  const focused = parts.find((p) => p.key === active) ?? null;
  return (
    <div data-testid="share-view">
      <p className="mb-3 text-sm text-muted-foreground">{caption}</p>
      <div className="relative">
        <ul
          className="m-0 flex h-7 list-none gap-0.5 p-0"
          aria-label="Share of the total"
        >
          {drawn.map((p) => (
            <li
              key={p.key}
              className="flex min-w-0.5"
              style={{ width: `${p.width}%` }}
            >
              <button
                type="button"
                aria-label={`${p.label} ${p.amount} (${p.share})`}
                onPointerEnter={() => setActive(p.key)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(p.key)}
                onBlur={() => setActive(null)}
                className="flex w-full min-w-0.5 cursor-default items-center overflow-hidden rounded pl-1.5 text-xs font-semibold outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                style={{
                  background: slotColor(p.slot),
                  color: DARK_INK.has(p.slot) ? "#0b0b0b" : "#ffffff",
                }}
              >
                {p.width >= 7 ? p.shareShort : null}
              </button>
            </li>
          ))}
        </ul>
        {focused ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-9 left-0 z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          >
            <strong className="font-semibold tabular-nums">
              {focused.amount}
            </strong>{" "}
            <span className="text-muted-foreground">
              {focused.label} · {focused.share}
            </span>
          </div>
        ) : null}
      </div>
      <table className="mt-4 w-full text-sm">
        <tbody>
          {parts.map((p) => (
            <tr key={p.key} className="border-b last:border-b-0">
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <span className="inline-flex items-center gap-2">
                  <SeriesKey slot={p.slot} mark="bar" />
                  {p.label}
                </span>
              </th>
              <td className="py-2 text-right tabular-nums">{p.amount}</td>
              <td className="w-20 py-2 pl-4 text-right tabular-nums text-muted-foreground">
                {p.share}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-2 text-left font-medium">
              Total
            </th>
            <td className="py-2 text-right font-medium tabular-nums">
              {total}
            </td>
            <td className="py-2 pl-4 text-right tabular-nums text-muted-foreground">
              {totalShare ?? ""}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
