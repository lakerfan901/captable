// The workbook of a quarterly or annual member report (04-investor-portal.md
// 5.7, package P7). Pure: builds a `WorkbookModel` from the report's figures;
// `src/server/xlsx/render.ts` turns it into bytes.
//
// Input is the report's own figures only (frozen at release, or stored for a
// draft). It takes no recipient, no holder id and no email address, so the
// workbook cannot contain any (S7). The only names in it are the payees and
// insider names that the report itself lists (2.4). `resolutionId` is an
// internal id and is not written.

import {
  formatDate,
  formatInstantDate,
  resolveTimeZone,
} from "../company-time";
import type { ReportFigures } from "../governance/report-figures";
import {
  date as dateCell,
  type HeadingLine,
  money,
  percent,
  type SheetModel,
  type SheetRow,
  sheetName,
  text,
  type WorkbookModel,
  workbookFileName,
} from "./workbook-model";

export type ExportableReportType = "QUARTERLY" | "ANNUAL";

export function isExportableReportType(
  type: string,
): type is ExportableReportType {
  return type === "QUARTERLY" || type === "ANNUAL";
}

export interface ReportWorkbookInput {
  companyName: string;
  title: string;
  type: ExportableReportType;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  periodStart: string | null; // YYYY-MM-DD
  periodEnd: string | null; // YYYY-MM-DD
  /** Release time; null for a draft. */
  releasedAt: Date | null;
  /** A draft: "DRAFT" in every title block and in the file name. */
  draft: boolean;
  /** A draft's last save; the workbook's date when there is no release. */
  savedAt: Date;
  /** The company's time zone (IANA). */
  timeZone: string;
  figures: ReportFigures;
}

export const NONE_IN_PERIOD = "None in this period";

/** "SOME_CATEGORY" → "Some category"; other text unchanged (as the report view). */
export function humanizeCategory(category: string): string {
  if (!/^[A-Z0-9_]+$/.test(category)) return category;
  const words = category.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "YYYY-MM-DD" of an instant in a time zone. */
export function ymdInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function periodLine(input: ReportWorkbookInput): string {
  const label =
    input.type === "QUARTERLY"
      ? "Quarterly report"
      : "Annual financial statements";
  const name =
    input.type === "QUARTERLY" && input.fiscalQuarter && input.fiscalYear
      ? `Q${input.fiscalQuarter} ${input.fiscalYear}`
      : input.fiscalYear
        ? `Fiscal year ${input.fiscalYear}`
        : null;
  const range =
    input.periodStart && input.periodEnd
      ? `${formatDate(input.periodStart)} – ${formatDate(input.periodEnd)}`
      : null;
  return [label, name, range].filter((p) => p !== null).join(" · ");
}

function titleBlock(
  input: ReportWorkbookInput,
  section: string,
): HeadingLine[] {
  const status: HeadingLine =
    input.releasedAt && !input.draft
      ? {
          text: `Released ${formatInstantDate(input.releasedAt, input.timeZone)}`,
          style: "meta",
        }
      : {
          text: `DRAFT, not released. Figures as last saved ${formatInstantDate(input.savedAt, input.timeZone)}.`,
          style: "alert",
        };
  return [
    { text: input.companyName, style: "title" },
    { text: input.title, style: "subtitle" },
    { text: periodLine(input), style: "meta" },
    status,
    { text: section, style: "subtitle" },
  ];
}

function sumCents(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function differs(stored: number | null, computed: number): boolean {
  return stored !== null && stored !== computed;
}

function formatCentsPlain(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = `$${dollars}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `(${out})` : out;
}

// ---------------------------------------------------------------------------
// Sheets

function summarySheet(input: ReportWorkbookInput): SheetModel {
  const f = input.figures;
  const rows: SheetRow[] = [];
  const line = (
    label: string,
    value: SheetRow["cells"][number],
    note = "",
    opts: { indent?: boolean; strong?: boolean } = {},
  ) => {
    rows.push({
      cells: [text(label), value, note.trim() === "" ? null : text(note)],
      ...opts,
    });
  };

  line("Period start", dateCell(input.periodStart));
  line("Period end", dateCell(input.periodEnd));
  if (input.releasedAt && !input.draft) {
    line("Released", dateCell(ymdInZone(input.releasedAt, input.timeZone)));
  }
  line("Gross Revenue", money(f.revenue.amountCents), f.revenue.note, {
    strong: true,
  });
  line("Utilization", percent(f.utilization.bps), f.utilization.note, {
    strong: true,
  });
  line("Total expenses", money(f.expenses.totalCents), f.expenses.note, {
    strong: true,
  });
  line(
    "Management Fee accrued",
    money(f.managementFee.accruedCents),
    f.managementFee.note,
    { strong: true },
  );
  line("Paid", money(f.managementFee.paidCents), "", { indent: true });
  line("Unpaid at period end", money(f.managementFee.unpaidAtEndCents), "", {
    indent: true,
  });
  line("Reserve balance", money(f.reserves.balanceCents), f.reserves.note, {
    strong: true,
  });
  line("Minimum required", money(f.reserves.minimumRequiredCents), "", {
    indent: true,
  });
  if (f.distributions.none) {
    line(
      "Distributions",
      text(
        input.type === "QUARTERLY"
          ? "No distribution this quarter"
          : "No distribution this period",
      ),
      f.distributions.note,
      { strong: true },
    );
  } else {
    line(
      "Distributions",
      money(f.distributions.totalCents),
      f.distributions.note,
      { strong: true },
    );
    line("Preferred Return", money(f.distributions.preferredReturnCents), "", {
      indent: true,
    });
    line("Return of capital", money(f.distributions.returnOfCapitalCents), "", {
      indent: true,
    });
    line("Residual", money(f.distributions.residualCents), "", {
      indent: true,
    });
  }
  const mp = f.managerPayments;
  const anyPayments =
    mp.lines.length +
      mp.insiderDistributions.length +
      mp.insiderLoanPayments.length >
    0;
  line(
    "Paid to or through the Manager and its Affiliates",
    anyPayments || mp.grandTotalCents !== null
      ? money(mp.grandTotalCents)
      : text(NONE_IN_PERIOD),
    anyPayments ? "Itemized on the Manager payments sheet." : "",
    { strong: true },
  );

  return {
    name: sheetName("Summary"),
    heading: titleBlock(input, "Figures"),
    columns: [
      { header: "Figure", width: 44, kind: "text" },
      { header: "Amount", width: 20, kind: "money" },
      { header: "Note", width: 70, kind: "text" },
    ],
    rows,
  };
}

function expensesSheet(input: ReportWorkbookInput): SheetModel {
  const e = input.figures.expenses;
  const heading = titleBlock(input, "Expenses by category");
  const computed = sumCents(e.lines.map((l) => l.amountCents));
  if (e.lines.length > 0 && differs(e.totalCents, computed)) {
    heading.push({
      text: `The report states total expenses of ${formatCentsPlain(e.totalCents ?? 0)}; the lines below add up to ${formatCentsPlain(computed)}.`,
      style: "alert",
    });
  }
  return {
    name: sheetName("Expenses"),
    heading,
    columns: [
      { header: "Category", width: 44, kind: "text" },
      { header: "Amount", width: 20, kind: "money" },
    ],
    rows: e.lines.map((l) => ({
      cells: [text(humanizeCategory(l.category)), money(l.amountCents)],
    })),
    emptyText: NONE_IN_PERIOD,
    totals: { label: "Total expenses", columns: [1] },
  };
}

function managerPaymentsSheet(input: ReportWorkbookInput): SheetModel {
  const mp = input.figures.managerPayments;
  const heading = titleBlock(
    input,
    "Amounts paid to or through the Manager and its Affiliates",
  );
  const rows: SheetRow[] = [];
  for (const l of mp.lines) {
    rows.push({
      cells: [
        text("Payment"),
        dateCell(l.paidOn),
        text(l.payee),
        text(humanizeCategory(l.category)),
        text(l.flow === "TO" ? "To" : "Through"),
        l.memo && l.memo.trim() !== "" ? text(l.memo) : null,
        money(l.amountCents),
      ],
    });
  }
  for (const d of mp.insiderDistributions) {
    rows.push({
      cells: [
        text("Distribution"),
        dateCell(d.paymentDate),
        text(d.name),
        text("Distribution (net)"),
        null,
        null,
        money(d.netCents),
      ],
    });
  }
  for (const l of mp.insiderLoanPayments) {
    for (const [part, cents] of [
      ["Loan principal", l.principalCents],
      ["Loan interest", l.interestCents],
    ] as const) {
      rows.push({
        cells: [
          text("Loan repayment"),
          dateCell(l.paidOn),
          text(l.name),
          text(part),
          null,
          null,
          money(cents),
        ],
      });
    }
  }
  const computed = sumCents(
    rows.map((r) => {
      const c = r.cells[6];
      return c?.kind === "money" ? c.cents : 0;
    }),
  );
  if (rows.length > 0 && differs(mp.grandTotalCents, computed)) {
    heading.push({
      text: `The report states a total of ${formatCentsPlain(mp.grandTotalCents ?? 0)}; the lines below add up to ${formatCentsPlain(computed)}.`,
      style: "alert",
    });
  }
  return {
    name: sheetName("Manager payments"),
    heading,
    columns: [
      { header: "Type", width: 16, kind: "text" },
      { header: "Date", width: 14, kind: "date" },
      { header: "Payee", width: 28, kind: "text" },
      { header: "Category", width: 24, kind: "text" },
      { header: "Paid to or through", width: 12, kind: "text" },
      { header: "Memo", width: 40, kind: "text" },
      { header: "Amount", width: 18, kind: "money" },
    ],
    rows,
    emptyText: NONE_IN_PERIOD,
    totals: { label: "Grand total", columns: [6] },
  };
}

// ---------------------------------------------------------------------------

export function reportWorkbook(input: ReportWorkbookInput): WorkbookModel {
  const timeZone = resolveTimeZone(input.timeZone);
  const normalized = { ...input, timeZone };
  return {
    fileName: workbookFileName([
      input.companyName,
      input.title,
      input.periodEnd ?? "",
      input.draft ? "DRAFT" : "",
    ]),
    title: input.draft ? `${input.title} (DRAFT)` : input.title,
    author: input.companyName,
    createdAt:
      input.releasedAt && !input.draft ? input.releasedAt : input.savedAt,
    sheets: [
      summarySheet(normalized),
      expensesSheet(normalized),
      managerPaymentsSheet(normalized),
    ],
  };
}
