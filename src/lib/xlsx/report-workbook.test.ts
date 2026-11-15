import { describe, expect, test } from "vitest";
import {
  EMPTY_FIGURES,
  type ReportFigures,
} from "../governance/report-figures";
import {
  dateCell,
  humanizeCategory,
  isExportableReportType,
  NONE_IN_PERIOD,
  type ReportWorkbookInput,
  reportWorkbook,
  ymdInZone,
} from "./report-workbook";
import { type Cell, sheetLayout, sheetTotals } from "./workbook-model";

function figures(): ReportFigures {
  return {
    source: {
      fetchedAt: "2026-10-02T15:00:00.000Z",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
    },
    revenue: { amountCents: 12_500_010, note: "Three months of rentals." },
    utilization: { bps: 8250, note: "" },
    expenses: {
      totalCents: 4_100_030,
      lines: [
        { category: "POWER", amountCents: 3_000_010 },
        { category: "COLOCATION_FEES", amountCents: 1_100_020 },
      ],
      note: "",
    },
    managementFee: {
      accruedCents: 625_000,
      paidCents: 600_000,
      unpaidAtEndCents: 25_000,
      note: "",
    },
    reserves: {
      balanceCents: 5_000_000,
      minimumRequiredCents: 4_000_000,
      note: "",
    },
    distributions: {
      totalCents: 1_000_000,
      preferredReturnCents: 800_000,
      returnOfCapitalCents: 200_000,
      residualCents: 0,
      none: false,
      note: "",
    },
    managerPayments: {
      lines: [
        {
          paidOn: "2026-08-15",
          payee: "=1+1",
          category: "MANAGEMENT_FEE",
          flow: "TO",
          amountCents: 600_000,
          memo: "+cmd|' /C calc'!A0",
          resolutionId: "res_secret_internal_id",
        },
        {
          paidOn: "2026-09-01",
          payee: "Acme Hosting",
          category: "Reimbursement",
          flow: "THROUGH",
          amountCents: -1_250,
          memo: null,
          resolutionId: null,
        },
      ],
      insiderDistributions: [
        {
          name: "Manager Holdings",
          paymentDate: "2026-09-30",
          netCents: 50_000,
        },
      ],
      insiderLoanPayments: [
        {
          name: "Manager Holdings",
          paidOn: "2026-09-15",
          principalCents: 10_000,
          interestCents: 333,
        },
      ],
      grandTotalCents: 659_083,
      confirmedNone: false,
    },
  };
}

function input(over: Partial<ReportWorkbookInput> = {}): ReportWorkbookInput {
  return {
    companyName: "Acme GPU Fund, LLC",
    title: "Q3 2026 report to Members",
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: 3,
    periodStart: "2026-07-01",
    periodEnd: "2026-09-30",
    releasedAt: new Date("2026-10-15T03:30:00.000Z"), // Oct 14 in Denver
    draft: false,
    savedAt: new Date("2026-10-14T20:00:00.000Z"),
    timeZone: "America/Denver",
    figures: figures(),
    ...over,
  };
}

function textOf(cell: Cell | undefined): string | null {
  return cell?.kind === "text" ? cell.value : null;
}

describe("reportWorkbook", () => {
  test("three named sheets, file name, properties", () => {
    const wb = reportWorkbook(input());
    expect(wb.sheets.map((s) => s.name)).toEqual([
      "Summary",
      "Expenses",
      "Manager payments",
    ]);
    expect(wb.fileName).toBe(
      "Acme-GPU-Fund-LLC-Q3-2026-report-to-Members-2026-09-30.xlsx",
    );
    expect(wb.author).toBe("Acme GPU Fund, LLC");
    expect(wb.createdAt.toISOString()).toBe("2026-10-15T03:30:00.000Z");
  });

  test("title block: company, title, period, release date in the company zone", () => {
    const wb = reportWorkbook(input());
    const heading = wb.sheets[0]?.heading.map((h) => h.text);
    expect(heading?.[0]).toBe("Acme GPU Fund, LLC");
    expect(heading?.[1]).toBe("Q3 2026 report to Members");
    expect(heading?.[2]).toBe(
      "Quarterly report · Q3 2026 · Jul 1, 2026 – Sep 30, 2026",
    );
    expect(heading?.[3]).toBe("Released Oct 14, 2026");
    for (const s of wb.sheets) {
      expect(s.heading.slice(0, 4).map((h) => h.text)).toEqual(
        heading?.slice(0, 4),
      );
    }
  });

  test("a draft says DRAFT everywhere and dates from its last save", () => {
    const wb = reportWorkbook(input({ draft: true, releasedAt: null }));
    expect(wb.fileName).toMatch(/-DRAFT\.xlsx$/);
    expect(wb.title).toContain("DRAFT");
    expect(wb.createdAt.toISOString()).toBe("2026-10-14T20:00:00.000Z");
    for (const s of wb.sheets) {
      const status = s.heading[3];
      expect(status?.style).toBe("alert");
      expect(status?.text).toMatch(/^DRAFT/);
      expect(status?.text).toContain("Oct 14, 2026");
    }
    const summary = wb.sheets[0];
    expect(summary?.rows.some((r) => textOf(r.cells[0]) === "Released")).toBe(
      false,
    );
  });

  test("summary: period dates are date cells, money in cents, percent in bps", () => {
    const summary = reportWorkbook(input()).sheets[0];
    const byLabel = new Map(
      summary?.rows.map((r) => [textOf(r.cells[0]), r.cells]) ?? [],
    );
    expect(byLabel.get("Period start")?.[1]).toEqual({
      kind: "date",
      ymd: "2026-07-01",
    });
    expect(byLabel.get("Period end")?.[1]).toEqual({
      kind: "date",
      ymd: "2026-09-30",
    });
    expect(byLabel.get("Released")?.[1]).toEqual({
      kind: "date",
      ymd: "2026-10-14",
    });
    expect(byLabel.get("Gross Revenue")?.[1]).toEqual({
      kind: "money",
      cents: 12_500_010,
    });
    expect(byLabel.get("Gross Revenue")?.[2]).toEqual({
      kind: "text",
      value: "Three months of rentals.",
    });
    expect(byLabel.get("Utilization")?.[1]).toEqual({
      kind: "percent",
      bps: 8250,
    });
    expect(byLabel.get("Preferred Return")?.[1]).toEqual({
      kind: "money",
      cents: 800_000,
    });
    expect(
      byLabel.get("Paid to or through the Manager and its Affiliates")?.[1],
    ).toEqual({ kind: "money", cents: 659_083 });
  });

  test("a figure not entered is a blank cell, not zero", () => {
    const f = figures();
    f.managementFee.paidCents = null;
    f.utilization.bps = null;
    const summary = reportWorkbook(input({ figures: f })).sheets[0];
    const paid = summary?.rows.find((r) => textOf(r.cells[0]) === "Paid");
    const util = summary?.rows.find(
      (r) => textOf(r.cells[0]) === "Utilization",
    );
    expect(paid?.cells[1]).toBeNull();
    expect(util?.cells[1]).toBeNull();
  });

  test("no distribution is a sentence, without tier rows", () => {
    const f = figures();
    f.distributions = { ...EMPTY_FIGURES.distributions, none: true };
    const summary = reportWorkbook(input({ figures: f })).sheets[0];
    const labels = summary?.rows.map((r) => textOf(r.cells[0]));
    expect(labels).not.toContain("Preferred Return");
    const row = summary?.rows.find(
      (r) => textOf(r.cells[0]) === "Distributions",
    );
    expect(textOf(row?.cells[1])).toBe("No distribution this quarter");
  });

  test("expenses: one row per category and a total over the lines", () => {
    const sheet = reportWorkbook(input()).sheets[1];
    expect(sheet?.rows.map((r) => textOf(r.cells[0]))).toEqual([
      "Power",
      "Colocation fees",
    ]);
    const layout = sheet ? sheetLayout(sheet) : null;
    expect(sheet && sheetTotals(sheet)).toEqual([
      {
        column: 1,
        formula: `SUM(B${layout?.firstRow}:B${layout?.lastRow})`,
        result: 41_000.3,
        kind: "money",
      },
    ]);
    // The stored total equals the lines: no warning line.
    expect(sheet?.heading.some((h) => h.style === "alert")).toBe(false);
  });

  test("a stored total that differs from the lines is called out", () => {
    const f = figures();
    f.expenses.totalCents = 5_000_000;
    const sheet = reportWorkbook(input({ figures: f })).sheets[1];
    const alert = sheet?.heading.find((h) => h.style === "alert");
    expect(alert?.text).toContain("$50,000.00");
    expect(alert?.text).toContain("$41,000.30");
  });

  test("manager payments: payments, insider distributions, loan principal and interest; grand total", () => {
    const sheet = reportWorkbook(input()).sheets[2];
    expect(sheet?.rows.map((r) => textOf(r.cells[0]))).toEqual([
      "Payment",
      "Payment",
      "Distribution",
      "Loan repayment",
      "Loan repayment",
    ]);
    expect(sheet?.rows[0]?.cells[1]).toEqual({
      kind: "date",
      ymd: "2026-08-15",
    });
    expect(textOf(sheet?.rows[0]?.cells[2])).toBe("=1+1");
    expect(textOf(sheet?.rows[0]?.cells[3])).toBe("Management fee");
    expect(textOf(sheet?.rows[0]?.cells[4])).toBe("To");
    expect(textOf(sheet?.rows[1]?.cells[4])).toBe("Through");
    expect(sheet?.rows[1]?.cells[5]).toBeNull();
    expect(sheet?.rows[1]?.cells[6]).toEqual({ kind: "money", cents: -1_250 });
    const totals = sheet ? sheetTotals(sheet) : [];
    // 600,000 − 1,250 + 50,000 + 10,000 + 333 = 659,083 cents.
    expect(totals[0]?.result).toBe(6_590.83);
    expect(sheet?.heading.some((h) => h.style === "alert")).toBe(false);
  });

  test("empty sections say so", () => {
    const f = figures();
    f.expenses.lines = [];
    f.managerPayments = {
      ...EMPTY_FIGURES.managerPayments,
      confirmedNone: true,
    };
    const wb = reportWorkbook(input({ figures: f }));
    for (const s of wb.sheets.slice(1)) {
      expect(s.rows).toEqual([]);
      expect(s.emptyText).toBe(NONE_IN_PERIOD);
      expect(sheetTotals(s)).toEqual([]);
    }
    const last = wb.sheets[0]?.rows.at(-1);
    expect(textOf(last?.cells[1])).toBe(NONE_IN_PERIOD);
  });

  test("no internal id reaches the workbook (S7)", () => {
    const json = JSON.stringify(reportWorkbook(input()));
    expect(json).not.toContain("res_secret_internal_id");
    expect(json).not.toContain("resolutionId");
    expect(json).not.toContain("fetchedAt");
  });

  test("two builds of one report are identical", () => {
    expect(JSON.stringify(reportWorkbook(input()))).toBe(
      JSON.stringify(reportWorkbook(input())),
    );
  });
});

describe("helpers", () => {
  test("only quarterly and annual reports are exportable", () => {
    expect(isExportableReportType("QUARTERLY")).toBe(true);
    expect(isExportableReportType("ANNUAL")).toBe(true);
    expect(isExportableReportType("TAX_K1")).toBe(false);
    expect(isExportableReportType("NOTICE")).toBe(false);
  });

  test("a stored date that is not a calendar date stays as text", () => {
    expect(dateCell("2026-02-31")).toEqual({
      kind: "text",
      value: "2026-02-31",
    });
    expect(dateCell("2026-02-28")).toEqual({ kind: "date", ymd: "2026-02-28" });
    expect(dateCell(null)).toBeNull();
    const f = figures();
    const first = f.managerPayments.lines[0];
    if (first) first.paidOn = "2026-02-31";
    const sheet = reportWorkbook(input({ figures: f })).sheets[2];
    expect(sheet?.rows[0]?.cells[1]).toEqual({
      kind: "text",
      value: "2026-02-31",
    });
  });

  test("ymdInZone is the calendar day in that zone", () => {
    const at = new Date("2026-10-15T03:30:00.000Z");
    expect(ymdInZone(at, "America/Denver")).toBe("2026-10-14");
    expect(ymdInZone(at, "UTC")).toBe("2026-10-15");
    expect(ymdInZone(at, "not/a-zone")).toBe("2026-10-14"); // default zone
  });

  test("humanizeCategory", () => {
    expect(humanizeCategory("COLOCATION_FEES")).toBe("Colocation fees");
    expect(humanizeCategory("Custom text")).toBe("Custom text");
  });
});
