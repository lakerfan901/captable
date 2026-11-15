/**
 * Renders a report workbook with ExcelJS, reads it back with ExcelJS and
 * checks the P7 acceptance list (04-investor-portal.md 5.7, 8 P7). Not part of
 * `vitest run` (vitest has no `@/` alias and no ExcelJS round trip). Needs no
 * database. Run from the repository root:
 *
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/xlsx/render.integration.ts [downloaded.xlsx]
 *
 * Without an argument it renders a fixture report (with a payee "=1+1", a
 * negative amount, loan principal and interest) and checks everything,
 * including that two renders read back identically. With a path it also
 * checks that file (for example one downloaded from the browser) against the
 * structural rules: sheet names, frozen bold header, number formats, totals
 * as formulas with cached results, print setup and properties.
 *
 * Run it under two zones to prove dates do not shift:
 *   TZ=Pacific/Kiritimati … and TZ=Pacific/Pago_Pago …
 */
import { readFile } from "node:fs/promises";
import type { Workbook, Worksheet } from "exceljs";
import {
  EMPTY_FIGURES,
  type ReportFigures,
} from "@/lib/governance/report-figures";
import { reportWorkbook } from "@/lib/xlsx/report-workbook";
import { NUMBER_FORMATS, sheetLayout } from "@/lib/xlsx/workbook-model";
import { renderWorkbook } from "./render";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` (${detail})` : ""}`,
  );
  if (!ok) failures++;
}

async function load(bytes: Buffer): Promise<Workbook> {
  const mod = (await import("exceljs")) as typeof import("exceljs") & {
    default?: typeof import("exceljs");
  };
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

/** Row of the header: the first row whose first cell has a dark fill. */
function headerRowOf(ws: Worksheet): number {
  for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
    const fill = ws.getCell(r, 1).fill;
    if (fill?.type === "pattern" && fill.pattern === "solid") return r;
  }
  return -1;
}

/** Structural rules every report workbook must follow. */
function checkStructure(label: string, wb: Workbook) {
  console.log(`\n${label}`);
  const names = wb.worksheets.map((w) => w.name);
  check(
    "three sheets named Summary, Expenses, Manager payments",
    JSON.stringify(names) ===
      JSON.stringify(["Summary", "Expenses", "Manager payments"]),
    names.join(", "),
  );
  check(
    "creator is set",
    Boolean(wb.creator) && wb.creator !== "ExcelJS",
    wb.creator,
  );
  check(
    "lastModifiedBy is the creator",
    wb.lastModifiedBy === wb.creator,
    wb.lastModifiedBy,
  );
  check(
    "created equals modified (not two different clock reads)",
    wb.created?.getTime() === wb.modified?.getTime(),
    `${wb.created?.toISOString()} / ${wb.modified?.toISOString()}`,
  );

  for (const ws of wb.worksheets) {
    const h = headerRowOf(ws);
    const view = ws.views[0] as
      | { state?: string; ySplit?: number; showGridLines?: boolean }
      | undefined;
    check(`${ws.name}: header row found`, h > 0, String(h));
    check(
      `${ws.name}: header row frozen`,
      view?.state === "frozen" && view.ySplit === h,
      JSON.stringify(view),
    );
    check(`${ws.name}: gridlines hidden`, view?.showGridLines === false);
    let allBold = true;
    for (let c = 1; c <= ws.columnCount; c++) {
      if (!ws.getCell(h, c).font?.bold) allBold = false;
    }
    check(`${ws.name}: header row bold`, allBold);
    check(
      `${ws.name}: header has a bottom border`,
      Boolean(ws.getCell(h, 1).border?.bottom?.style),
    );
    const ps = ws.pageSetup;
    check(
      `${ws.name}: landscape, one page wide`,
      ps.orientation === "landscape" &&
        ps.fitToPage === true &&
        ps.fitToWidth === 1 &&
        ps.fitToHeight === 0,
      JSON.stringify({
        o: ps.orientation,
        f: ps.fitToPage,
        w: ps.fitToWidth,
        hh: ps.fitToHeight,
      }),
    );
    check(
      `${ws.name}: header row repeated when printed`,
      ps.printTitlesRow === `${h}:${h}`,
      String(ps.printTitlesRow),
    );
    check(
      `${ws.name}: margins 0.5 inch left and right`,
      ps.margins?.left === 0.5 && ps.margins?.right === 0.5,
    );
    check(
      `${ws.name}: footer has the page count`,
      (ws.headerFooter.oddFooter ?? "").includes("Page &P of &N"),
      ws.headerFooter.oddFooter ?? "",
    );
    let widthsOk = true;
    for (let c = 1; c <= ws.columnCount; c++) {
      const w = ws.getColumn(c).width ?? 0;
      if (w < 10) widthsOk = false;
    }
    check(`${ws.name}: column widths set`, widthsOk);

    // Every number cell under the header has a number format of 5.7, and
    // every money format shows negatives red in parentheses.
    let formatsOk = true;
    const allowed = new Set<string>(Object.values(NUMBER_FORMATS));
    for (let r = h + 1; r <= ws.rowCount; r++) {
      ws.getRow(r).eachCell((cell) => {
        const v = cell.value;
        const isNumber =
          typeof v === "number" ||
          v instanceof Date ||
          (typeof v === "object" && v !== null && "formula" in v);
        if (isNumber && !allowed.has(cell.numFmt)) formatsOk = false;
      });
    }
    check(
      `${ws.name}: numbers carry the money/percent/date/integer formats`,
      formatsOk,
    );
  }

  // Totals: a SUM formula whose cached result equals the cents of the rows.
  for (const [name, col] of [
    ["Expenses", 2],
    ["Manager payments", 7],
  ] as const) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    const h = headerRowOf(ws);
    let cents = 0;
    let totalCell: { formula: string; result: unknown } | null = null;
    let totalRow = -1;
    for (let r = h + 1; r <= ws.rowCount; r++) {
      const v = ws.getCell(r, col).value;
      if (typeof v === "number") cents += Math.round(v * 100);
      else if (v && typeof v === "object" && "formula" in v) {
        totalCell = v as { formula: string; result: unknown };
        totalRow = r;
      }
    }
    if (totalCell === null) {
      const empty = ws.getCell(h + 1, 1).value;
      check(
        `${name}: empty section says so`,
        empty === "None in this period",
        String(empty),
      );
      continue;
    }
    const letter = String.fromCharCode(64 + col);
    check(
      `${name}: total is a SUM over the table`,
      totalCell.formula === `SUM(${letter}${h + 1}:${letter}${totalRow - 1})`,
      totalCell.formula,
    );
    check(
      `${name}: cached total equals sum of integer cents ÷ 100`,
      totalCell.result === cents / 100,
      `${String(totalCell.result)} vs ${cents / 100}`,
    );
    check(
      `${name}: total row is bold with a top border`,
      ws.getCell(totalRow, 1).font?.bold === true &&
        Boolean(ws.getCell(totalRow, col).border?.top?.style),
    );
    check(
      `${name}: money format shows negatives red in parentheses`,
      ws.getCell(totalRow, col).numFmt === '"$"#,##0.00;[Red]("$"#,##0.00)',
    );
  }
}

/** Every cell of every sheet with value, format, font and alignment. */
function snapshot(wb: Workbook): string {
  const out: unknown[] = [
    wb.creator,
    wb.lastModifiedBy,
    wb.created?.toISOString(),
    wb.modified?.toISOString(),
    wb.title,
  ];
  for (const ws of wb.worksheets) {
    out.push(ws.name, ws.views, ws.pageSetup, ws.headerFooter, ws.autoFilter);
    for (let c = 1; c <= ws.columnCount; c++) out.push(ws.getColumn(c).width);
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        out.push([
          r,
          c,
          cell.value instanceof Date ? cell.value.toISOString() : cell.value,
          cell.type,
          cell.numFmt,
          cell.font,
          cell.alignment,
          cell.border,
          cell.fill,
        ]);
      });
    });
  }
  return JSON.stringify(out);
}

function fixtureFigures(): ReportFigures {
  return {
    source: null,
    revenue: { amountCents: 12_500_010, note: "Three months of rentals." },
    utilization: { bps: 8250, note: "" },
    expenses: {
      totalCents: 4_100_030,
      lines: [
        { category: "POWER", amountCents: 3_000_010 },
        { category: "COLOCATION_FEES", amountCents: 1_100_020 },
        ...Array.from({ length: 6 }, (_, i) => ({
          category: `Item ${i + 1}`,
          amountCents: 0,
        })),
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
    distributions: { ...EMPTY_FIGURES.distributions, none: true },
    managerPayments: {
      lines: [
        {
          paidOn: "2026-08-15",
          payee: "=1+1",
          category: "MANAGEMENT_FEE",
          flow: "TO",
          amountCents: 600_000,
          memo: "@SUM(1,1)",
          resolutionId: "res_internal",
        },
        {
          paidOn: "2026-09-01",
          payee: "Acme & Sons",
          category: "Reimbursement",
          flow: "THROUGH",
          amountCents: -1_250,
          memo: null,
          resolutionId: null,
        },
      ],
      insiderDistributions: [],
      insiderLoanPayments: [
        {
          name: "Manager Holdings",
          paidOn: "2026-09-30",
          principalCents: 10_000,
          interestCents: 333,
        },
      ],
      grandTotalCents: 609_083,
      confirmedNone: false,
    },
  };
}

async function fixture() {
  const model = reportWorkbook({
    companyName: "Acme & Co GPU Fund, LLC",
    title: "Q3 2026 report to Members",
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: 3,
    periodStart: "2026-07-01",
    periodEnd: "2026-09-30",
    releasedAt: new Date("2026-10-15T03:30:00.000Z"),
    draft: false,
    savedAt: new Date("2026-10-14T20:00:00.000Z"),
    timeZone: "America/Denver",
    figures: fixtureFigures(),
  });
  const bytes1 = await renderWorkbook(model);
  await new Promise((r) => setTimeout(r, 1100)); // a different second
  const bytes2 = await renderWorkbook(model);
  const wb = await load(bytes1);
  checkStructure(`fixture (TZ=${process.env.TZ ?? "system"})`, wb);

  const summary = wb.getWorksheet("Summary");
  const payments = wb.getWorksheet("Manager payments");
  const expenses = wb.getWorksheet("Expenses");
  if (!summary || !payments || !expenses) throw new Error("missing sheet");

  // Dates read back as the same calendar day.
  const layout = sheetLayout(
    model.sheets[0] ?? { heading: [], rows: [], columns: [], name: "" },
  );
  const start = summary.getCell(layout.firstRow, 2);
  const end = summary.getCell(layout.firstRow + 1, 2);
  check(
    "period start is a date cell for 2026-07-01",
    start.value instanceof Date &&
      start.value.toISOString() === "2026-07-01T00:00:00.000Z" &&
      start.numFmt === "mmm d, yyyy",
    String(
      start.value instanceof Date ? start.value.toISOString() : start.value,
    ),
  );
  check(
    "period end is a date cell for 2026-09-30",
    end.value instanceof Date &&
      end.value.toISOString() === "2026-09-30T00:00:00.000Z",
  );
  check(
    "summary title block names the company",
    summary.getCell(1, 1).value === "Acme & Co GPU Fund, LLC",
  );
  check(
    "summary title block says Released Oct 14, 2026",
    summary.getCell(4, 1).value === "Released Oct 14, 2026",
    String(summary.getCell(4, 1).value),
  );

  // Money and percent are numbers.
  let revenue: unknown = null;
  let util: { value: unknown; numFmt: string } | null = null;
  summary.eachRow((row) => {
    if (row.getCell(1).value === "Gross Revenue")
      revenue = row.getCell(2).value;
    if (row.getCell(1).value === "Utilization") {
      util = { value: row.getCell(2).value, numFmt: row.getCell(2).numFmt };
    }
  });
  check(
    "revenue is the number 125000.1",
    revenue === 125_000.1,
    String(revenue),
  );
  check(
    "utilization is 0.825 with 0.00%",
    (util as { value: unknown; numFmt: string } | null)?.value === 0.825 &&
      (util as { value: unknown; numFmt: string } | null)?.numFmt === "0.00%",
  );

  // Injection: the payee "=1+1" and the memo "@SUM(1,1)" are text cells.
  const ph = headerRowOf(payments);
  const payee = payments.getCell(ph + 1, 3);
  const memo = payments.getCell(ph + 1, 6);
  check(
    'payee "=1+1" reads back as text',
    payee.value === "=1+1" && payee.type === 3 /* ValueType.String */,
    `${String(payee.value)} type ${payee.type}`,
  );
  check(
    'memo "@SUM(1,1)" reads back as text',
    memo.value === "@SUM(1,1)" && memo.type === 3,
  );
  const negative = payments.getCell(ph + 2, 7);
  check(
    "negative amount is a number",
    negative.value === -12.5,
    String(negative.value),
  );

  // Formulas exist only in total rows.
  let formulas = 0;
  for (const ws of wb.worksheets) {
    ws.eachRow((row) =>
      row.eachCell((cell) => {
        if (cell.type === 6 /* ValueType.Formula */) formulas++;
      }),
    );
  }
  check(
    "only the two total cells are formulas",
    formulas === 2,
    String(formulas),
  );

  check(
    "expenses (8 rows) has an auto-filter",
    Boolean(expenses.autoFilter),
    JSON.stringify(expenses.autoFilter),
  );
  check(
    "footer escapes & in the company name",
    (summary.headerFooter.oddFooter ?? "").includes("Acme && Co GPU Fund"),
  );
  check(
    "created is the release time",
    wb.created?.toISOString() === "2026-10-15T03:30:00.000Z",
    wb.created?.toISOString(),
  );

  const raw = bytes1.toString("latin1");
  check("no internal resolution id in the file", !raw.includes("res_internal"));

  const again = await load(bytes2);
  // Fresh loads: reading cells with getCell creates empty rows.
  const a = snapshot(await load(bytes1));
  const b = snapshot(again);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  check(
    "two renders read back identical (cells, formats, properties)",
    a === b,
    a === b
      ? ""
      : `first difference: ${a.slice(i - 30, i + 200)} VS ${b.slice(i - 30, i + 200)}`,
  );
  return bytes1;
}

async function main() {
  const path = process.argv[2];
  if (path) {
    const bytes = await readFile(path);
    checkStructure(`file ${path}`, await load(bytes));
  } else {
    await fixture();
  }
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
