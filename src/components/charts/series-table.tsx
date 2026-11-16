"use client";

import { useLayoutEffect, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useChartPrintMode } from "./chart-frame";
import type { TableModel } from "./chart-model";

/**
 * The table twin of a chart: exactly the plotted numbers (formatted by the
 * same function as the tooltip), every series including hidden ones, and a
 * totals row for the summed series.
 */
export function SeriesTable({
  model,
  firstColumn = "Period",
  caption,
  testId,
}: {
  model: TableModel;
  firstColumn?: string;
  caption: string;
  testId?: string;
}) {
  // printed whole: no scroll box (a clipped table would print cut off)
  const print = useChartPrintMode();
  const box = useRef<HTMLDivElement | null>(null);
  // printed: a table wider than the page even in small type (many series of
  // seven-digit amounts) is scaled down to the page width, never cut off
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the table changes
  useLayoutEffect(() => {
    const el = box.current;
    const table = el?.querySelector("table");
    if (!print || !el || !table) return;
    el.style.zoom = "1";
    const need = table.scrollWidth;
    const have = el.clientWidth;
    if (need > have && have > 0) {
      el.style.zoom = String(
        Math.max(0.5, Math.floor((have / need) * 100) / 100),
      );
    }
  }, [print, model]);
  return (
    <div
      ref={box}
      className={print ? "mt-4" : "max-h-[22rem] overflow-auto"}
      data-testid={testId}
    >
      {/* printed: smaller type and wrapping headers, so every column fits the page */}
      <Table
        className={
          print
            ? model.columns.length > 5
              ? "text-[10px]"
              : "text-xs"
            : undefined
        }
      >
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead
              className={cn(
                "h-10 whitespace-nowrap",
                print ? "px-1.5" : "px-3",
              )}
            >
              {firstColumn}
            </TableHead>
            {model.columns.map((c) => (
              <TableHead
                key={c.key}
                className={cn(
                  "h-10 text-right",
                  print ? "px-1.5 whitespace-normal" : "whitespace-nowrap px-3",
                )}
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.rows.map((r) => (
            <TableRow key={r.key} data-row={r.key}>
              <TableHead
                scope="row"
                className={cn(
                  "h-auto whitespace-nowrap py-2 font-normal text-foreground",
                  print ? "px-1.5" : "px-3",
                )}
              >
                {r.label}
              </TableHead>
              {r.cells.map((cell, i) => (
                <TableCell
                  key={model.columns[i]?.key ?? i}
                  data-col={model.columns[i]?.key}
                  className={cn(
                    "whitespace-nowrap py-2 text-right tabular-nums",
                    print ? "px-1.5" : "px-3",
                  )}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {model.totals ? (
            <TableRow
              className={cn("bg-muted/50 font-medium")}
              data-row="__totals"
            >
              <TableHead
                scope="row"
                className={cn(
                  "h-auto py-2 font-medium text-foreground",
                  print ? "px-1.5" : "px-3",
                )}
              >
                Total
              </TableHead>
              {model.totals.map((cell, i) => (
                <TableCell
                  key={model.columns[i]?.key ?? i}
                  className={cn(
                    "whitespace-nowrap py-2 text-right tabular-nums",
                    print ? "px-1.5" : "px-3",
                  )}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
