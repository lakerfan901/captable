import "server-only";
import { TRPCError } from "@trpc/server";
import { utcDateToYmd } from "@/lib/governance/dates";
import {
  isExportableReportType,
  reportWorkbook,
} from "@/lib/xlsx/report-workbook";
import {
  readFrozenContent,
  storedFigures,
} from "@/trpc/routers/member-report-router/procedures/shared";
import { renderWorkbook } from "./render";

// The Excel export of one member report (04-investor-portal.md 5.7), shared
// by the team procedure (`memberReport.exportXlsx`) and the portal procedure
// (`portal.reports.exportXlsx`). The caller has already found the report
// within its company and decided that the caller may see it; this function
// only chooses the figures and renders.
//
// A SENT report is exported from its frozen content only (title and
// figures frozen at release); a DRAFT from its stored figures, marked DRAFT.
// Nothing about recipients is read.

export interface ExportableReportRow {
  type: string;
  status: string;
  title: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  sentAt: Date | null;
  updatedAt: Date;
  figures: unknown;
  frozenContent: unknown;
}

export interface ReportExportFile {
  fileName: string;
  base64: string;
}

function refuse(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

export async function exportReportXlsx(
  row: ExportableReportRow,
  company: { name: string; timeZone: string },
): Promise<ReportExportFile> {
  const type = row.type;
  if (!isExportableReportType(type)) {
    refuse("Only quarterly and annual reports have figures to export.");
  }
  let title = row.title;
  let figures = null;
  if (row.status === "SENT") {
    const frozen = readFrozenContent(row.frozenContent);
    if (!frozen?.figures) {
      refuse("The released figures of this report could not be read.");
    }
    title = frozen.title;
    figures = frozen.figures;
  } else {
    figures = storedFigures(type, row.figures);
    if (!figures) refuse("The figures of this draft could not be read.");
  }
  const draft = row.status !== "SENT";
  const model = reportWorkbook({
    companyName: company.name,
    title,
    type,
    fiscalYear: row.fiscalYear,
    fiscalQuarter: row.fiscalQuarter,
    periodStart: row.periodStart ? utcDateToYmd(row.periodStart) : null,
    periodEnd: row.periodEnd ? utcDateToYmd(row.periodEnd) : null,
    releasedAt: draft ? null : row.sentAt,
    draft,
    savedAt: row.updatedAt,
    timeZone: company.timeZone,
    figures,
  });
  const bytes = await renderWorkbook(model);
  return { fileName: model.fileName, base64: bytes.toString("base64") };
}
