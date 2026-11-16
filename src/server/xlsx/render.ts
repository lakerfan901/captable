import "server-only";
import {
  AUTO_FILTER_MIN_ROWS,
  type Cell,
  type CellKind,
  cellValue,
  columnLetter,
  numberFormat,
  type SheetModel,
  sheetLayout,
  sheetTotals,
  valueKind,
  type WorkbookModel,
} from "@/lib/xlsx/workbook-model";

// Renders a `WorkbookModel` (src/lib/xlsx/workbook-model.ts) to .xlsx bytes
// with ExcelJS (04-investor-portal.md 5.7). The only file that imports the
// library, and only with `await import`, so it never enters a browser bundle
// and can be replaced alone.
//
// Formulas are written only here, only for the totals, from cell addresses
// computed here; every text value is written as a plain string, which ExcelJS
// stores as a string cell (never a formula), so user text such as "=1+1"
// stays text (S20).

type ExcelJsModule = typeof import("exceljs");
type Worksheet = import("exceljs").Worksheet;
type Alignment = Partial<import("exceljs").Alignment>;

const FONT = "Calibri";
const HEADER_FILL = "FF1F2937"; // slate-800
const HEADER_TEXT = "FFFFFFFF";
const RULE = "FFD1D5DB"; // grey-300
const STRONG_RULE = "FF374151"; // grey-700
const META_TEXT = "FF6B7280"; // grey-500
const ALERT_TEXT = "FFB91C1C"; // red-700

async function loadExcelJs(): Promise<ExcelJsModule> {
  const mod = (await import("exceljs")) as ExcelJsModule & {
    default?: ExcelJsModule;
  };
  // ESM build (Next) vs CommonJS interop (tsx / Node).
  return mod.default ?? mod;
}

/** `&` starts a code in header and footer text; `&&` is a literal one. */
export function escapeHeaderFooter(value: string): string {
  return value.replace(/&/g, "&&");
}

/**
 * Text and date columns read left to right; number columns right-aligned,
 * whatever a cell in them holds (Summary mixes money, percent, dates and a
 * sentence in one column). Text wraps.
 */
function alignment(
  columnKind: CellKind,
  cellKind: CellKind,
  indent = false,
): Alignment {
  const left = columnKind === "text" || columnKind === "date";
  return {
    horizontal: left ? "left" : "right",
    vertical: "top",
    ...(cellKind === "text" ? { wrapText: true } : {}),
    ...(indent ? { indent: 2 } : {}),
  };
}

function writeCell(
  sheet: Worksheet,
  row: number,
  col: number,
  cell: Cell,
  columnKind: CellKind,
  opts: { strong?: boolean; indent?: boolean; rule?: boolean },
) {
  const target = sheet.getCell(row, col + 1);
  const kind = valueKind(cell) ?? columnKind;
  target.value = cellValue(cell);
  const format = numberFormat(kind);
  if (format) target.numFmt = format;
  // A strong row is bold in its label and figures, not in a free-text note.
  const bold = opts.strong === true && (col === 0 || columnKind !== "text");
  target.font = { name: FONT, size: 11, bold };
  target.alignment = alignment(columnKind, kind, opts.indent);
  if (opts.rule) {
    target.border = { bottom: { style: "hair", color: { argb: RULE } } };
  }
}

function writeSheet(sheet: Worksheet, model: SheetModel, footerLeft: string) {
  const layout = sheetLayout(model);
  const width = model.columns.length;

  model.columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width;
  });

  // Title block (not merged, not wrapped: long lines run over empty cells).
  model.heading.forEach((line, i) => {
    const cell = sheet.getCell(i + 1, 1);
    cell.value = line.text;
    cell.font =
      line.style === "title"
        ? { name: FONT, size: 14, bold: true }
        : line.style === "subtitle"
          ? { name: FONT, size: 11, bold: true }
          : line.style === "alert"
            ? { name: FONT, size: 11, bold: true, color: { argb: ALERT_TEXT } }
            : { name: FONT, size: 10, color: { argb: META_TEXT } };
    cell.alignment = {
      horizontal: "left",
      vertical: "middle",
      wrapText: false,
    };
    if (line.style === "title") sheet.getRow(i + 1).height = 20;
  });

  // Header row.
  const header = sheet.getRow(layout.headerRow);
  model.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = {
      name: FONT,
      size: 11,
      bold: true,
      color: { argb: HEADER_TEXT },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: HEADER_FILL },
    };
    cell.alignment = {
      horizontal: c.kind === "text" || c.kind === "date" ? "left" : "right",
      vertical: "middle",
      wrapText: true,
    };
    cell.border = {
      top: { style: "thin", color: { argb: HEADER_FILL } },
      bottom: { style: "medium", color: { argb: STRONG_RULE } },
      left: { style: "thin", color: { argb: HEADER_FILL } },
      right: { style: "thin", color: { argb: HEADER_FILL } },
    };
  });
  header.height = 30;

  // Table rows.
  model.rows.forEach((r, ri) => {
    const rowNumber = layout.firstRow + ri;
    model.columns.forEach((c, ci) => {
      writeCell(sheet, rowNumber, ci, r.cells[ci] ?? null, c.kind, {
        strong: r.strong,
        indent: ci === 0 && r.indent,
        rule: true,
      });
    });
  });
  if (model.rows.length === 0 && model.emptyText) {
    const cell = sheet.getCell(layout.firstRow, 1);
    cell.value = model.emptyText;
    cell.font = {
      name: FONT,
      size: 11,
      italic: true,
      color: { argb: META_TEXT },
    };
  }

  // Totals: a formula with the result computed from integer cents.
  if (layout.totalsRow !== null && model.totals) {
    const totalsRow = layout.totalsRow;
    for (let ci = 0; ci < width; ci++) {
      const cell = sheet.getCell(totalsRow, ci + 1);
      cell.font = { name: FONT, size: 11, bold: true };
      cell.border = {
        top: { style: "thin", color: { argb: STRONG_RULE } },
        bottom: { style: "double", color: { argb: STRONG_RULE } },
      };
      const kind = model.columns[ci]?.kind ?? "text";
      cell.alignment = alignment(kind, kind);
    }
    const label = sheet.getCell(totalsRow, 1);
    label.value = model.totals.label;
    for (const t of sheetTotals(model)) {
      const cell = sheet.getCell(totalsRow, t.column + 1);
      cell.value = { formula: t.formula, result: t.result };
      const format = numberFormat(t.kind);
      if (format) cell.numFmt = format;
    }
  }

  // Auto-filter on longer tables (header and data rows, not the totals).
  if (model.rows.length >= AUTO_FILTER_MIN_ROWS) {
    sheet.autoFilter = {
      from: { row: layout.headerRow, column: 1 },
      to: { row: layout.lastRow, column: width },
    };
  }

  // Frozen header (and row labels when asked), no gridlines.
  const xSplit = model.freezeColumns ?? 0;
  const topLeft = `${columnLetter(xSplit)}${layout.headerRow + 1}`;
  sheet.views = [
    {
      state: "frozen",
      xSplit,
      ySplit: layout.headerRow,
      topLeftCell: topLeft,
      activeCell: topLeft,
      showGridLines: false,
    },
  ];

  // Print: landscape, one page wide, header repeated, footer. No print area:
  // the used range is printed (ExcelJS writes a print area as "$A1:$C22",
  // a form some readers handle badly).
  sheet.pageSetup = {
    ...sheet.pageSetup,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: undefined,
    horizontalCentered: false,
    showGridLines: false,
    margins: {
      left: 0.5,
      right: 0.5,
      top: 0.5,
      bottom: 0.75,
      header: 0.3,
      footer: 0.3,
    },
    printTitlesRow: `${layout.headerRow}:${layout.headerRow}`,
  };
  const footer = `&L&8${escapeHeaderFooter(footerLeft)}&R&8Page &P of &N`;
  sheet.headerFooter = { oddFooter: footer, evenFooter: footer };
}

/** The workbook as .xlsx bytes. */
export async function renderWorkbook(model: WorkbookModel): Promise<Buffer> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = model.author;
  workbook.lastModifiedBy = model.author;
  workbook.created = model.createdAt;
  workbook.modified = model.createdAt;
  workbook.title = model.title;
  workbook.company = model.author;
  workbook.calcProperties = { fullCalcOnLoad: false };
  for (const sheetModel of model.sheets) {
    const sheet = workbook.addWorksheet(sheetModel.name);
    writeSheet(sheet, sheetModel, model.author);
  }
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
