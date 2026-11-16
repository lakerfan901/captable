import "server-only";
import { TRPCError } from "@trpc/server";
import { clampRange } from "@/lib/llc/financial-periods";
import {
  fundMonthFromJson,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import type { FinancialsExportView } from "@/lib/xlsx/financials-export-input";
import {
  type FinancialsSource,
  FinancialsWorkbookError,
  financialsWorkbook,
} from "@/lib/xlsx/financials-workbook";
import type { FinancialView } from "@/server/portal/financial-view";
import { renderWorkbook } from "./render";

// The Excel export of a dashboard view (04-investor-portal.md 5.9 "Export of
// the current view"; package P17), shared by `portal.financials.exportXlsx`
// and `financialDashboard.exportXlsx`. The caller has loaded exactly what
// the viewer's page shows (`FinancialView`: the investor's snapshots, the
// team's live or published months, or a previewed holder); this function
// only cuts the range to it, builds the model and renders. It reads nothing.
//
// The range is clamped to the published-through date (S30) for every
// source but Live, whose last month may be the month in progress (the
// builder cuts it to the months that exist in any case).

export interface FinancialsExportFile {
  fileName: string;
  base64: string;
  /** "Financials, Q1 2026 – Q4 2026, by quarter" (the access-log target name) */
  caption: string;
}

/** No published month to export (nothing released, unpublished, or a range outside it). */
export function nothingToExport(): never {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: "There are no published figures to export for this view.",
  });
}

export async function exportFinancialsXlsx(
  data: FinancialView,
  request: FinancialsExportView,
  opts: {
    companyName: string;
    source: FinancialsSource;
    /** the previewed holder (team preview only) */
    holderName?: string | null;
  },
): Promise<FinancialsExportFile> {
  if (data.publishedThrough === null || data.fundMonths.length === 0) {
    return nothingToExport();
  }
  const range =
    opts.source === "live"
      ? { from: request.from, to: request.to }
      : clampRange(
          { from: request.from, to: request.to },
          data.publishedThrough,
        );
  if (range === null) return nothingToExport();
  let model: ReturnType<typeof financialsWorkbook>;
  try {
    model = financialsWorkbook({
      companyName: opts.companyName,
      view: request.view,
      source: opts.source,
      holderName: opts.holderName ?? null,
      publishedThrough: data.publishedThrough,
      inceptionMonth: data.inceptionMonth,
      fundMonths: data.fundMonths.map(fundMonthFromJson),
      holderMonths: data.holderMonths.map(holderMonthFromJson),
      restatements: data.restatements,
      targetSaleDate: data.termClock?.targetSaleDate ?? null,
      grain: request.grain,
      from: range.from,
      to: range.to,
      focus: request.focus ?? null,
      compare: request.compare,
    });
  } catch (error) {
    if (error instanceof FinancialsWorkbookError) {
      if (error.code === "BAD_PERIOD") {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
      }
      return nothingToExport();
    }
    throw error;
  }
  const bytes = await renderWorkbook(model);
  const sep = model.title.indexOf(": ");
  return {
    fileName: model.fileName,
    base64: bytes.toString("base64"),
    caption: sep >= 0 ? model.title.slice(sep + 2) : model.title,
  };
}
