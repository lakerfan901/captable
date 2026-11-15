"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
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
  return (
    <div className="max-h-[22rem] overflow-auto" data-testid={testId}>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead className="h-10 whitespace-nowrap px-3">
              {firstColumn}
            </TableHead>
            {model.columns.map((c) => (
              <TableHead
                key={c.key}
                className="h-10 whitespace-nowrap px-3 text-right"
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
                className="h-auto whitespace-nowrap px-3 py-2 font-normal text-foreground"
              >
                {r.label}
              </TableHead>
              {r.cells.map((cell, i) => (
                <TableCell
                  key={model.columns[i]?.key ?? i}
                  data-col={model.columns[i]?.key}
                  className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
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
                className="h-auto px-3 py-2 font-medium text-foreground"
              >
                Total
              </TableHead>
              {model.totals.map((cell, i) => (
                <TableCell
                  key={model.columns[i]?.key ?? i}
                  className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
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
