// A small, library-free description of a formatted workbook
// (04-investor-portal.md 5.7). Builders (report-workbook.ts, later the
// dashboard export) produce a `WorkbookModel`; `src/server/xlsx/render.ts`
// is the only code that turns one into .xlsx bytes with ExcelJS.
//
// Pure: no database, no clock, no `@/` imports (vitest has no alias).
//
// Values are stored exactly: money as integer cents, percentages as basis
// points, dates as "YYYY-MM-DD". The renderer divides once per cell and the
// totals are summed here in integers, so no floating-point error reaches a
// total. Text is always a text value: the renderer never turns a string into
// a formula (spreadsheet formula injection, S20).

export type CellKind =
  | "text"
  | "money"
  | "percent"
  | "date"
  | "integer"
  | "multiple"
  | "units";

/** A number cell: the value a formula cell caches as its result. */
export type NumberCell =
  | { kind: "money"; cents: number }
  | { kind: "percent"; bps: number }
  | { kind: "integer"; value: number }
  /** a multiple in basis points of "x" (DPI: 1200 = 0.12x) */
  | { kind: "multiple"; bps: number }
  /** units in micro-units (6 decimals) */
  | { kind: "units"; micro: number };

export type Cell =
  | { kind: "text"; value: string }
  | { kind: "date"; ymd: string }
  | NumberCell
  /**
   * A formula built by the workbook code from cell addresses (`SUM(C7:F7)`,
   * `F7`), never from user text, with its result cached (ExcelJS does not
   * calculate). Formatted as its result.
   */
  | { kind: "formula"; formula: string; result: NumberCell }
  | null; // blank

export interface Column {
  header: string;
  /** Width in characters (Excel's unit). */
  width: number;
  /** Alignment and wrapping of the column; each cell carries its own format. */
  kind: CellKind;
}

export interface HeadingLine {
  text: string;
  /** title: large bold; subtitle: bold; meta: plain grey; alert: bold red. */
  style: "title" | "subtitle" | "meta" | "alert";
}

export interface SheetRow {
  cells: Cell[];
  /** Bold row (a subtotal or section line). */
  strong?: boolean;
  /** Indented first cell (a line under the row above). */
  indent?: boolean;
}

export interface SheetModel {
  name: string;
  /** Title block lines, above one empty row and the header row. */
  heading: HeadingLine[];
  columns: Column[];
  rows: SheetRow[];
  /**
   * Columns frozen at the left (with the header rows): 1 keeps the row
   * labels in view on a wide sheet. Default 0.
   */
  freezeColumns?: number;
  /** Line written under the header row when `rows` is empty. */
  emptyText?: string;
  /**
   * A bold total row under the table: `label` in the first column and, for
   * each listed (money or integer) column, `SUM(...)` over the table rows
   * with the integer result cached. Not written when `rows` is empty.
   */
  totals?: { label: string; columns: number[] };
}

export interface WorkbookModel {
  fileName: string;
  /** Workbook title property. */
  title: string;
  /** Creator and last-modified-by property; also the left footer. */
  author: string;
  /**
   * Created and modified property. The release time (not "now"), so two
   * exports of one report carry the same content.
   */
  createdAt: Date;
  sheets: SheetModel[];
}

// ---------------------------------------------------------------------------
// Cells

// XML 1.0 forbids these; ExcelJS would write them and Excel would then ask to
// repair the file. Tab, LF and CR are allowed and kept.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Excel's limit for the characters of one cell. */
export const MAX_CELL_CHARS = 32_767;

/** Text safe to store in a cell (forbidden characters removed, length capped). */
export function cleanText(value: string): string {
  const cleaned = value.replace(XML_FORBIDDEN, "").replace(LONE_SURROGATE, "");
  return cleaned.length > MAX_CELL_CHARS
    ? cleaned.slice(0, MAX_CELL_CHARS)
    : cleaned;
}

export function text(value: string): Cell {
  return { kind: "text", value: cleanText(value) };
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${what} must be a safe integer, got ${value}`);
  }
}

/** Integer cents; null gives a blank cell. */
export function money(cents: number | null): Cell {
  if (cents === null) return null;
  assertSafeInteger(cents, "Money cents");
  return { kind: "money", cents };
}

/** Basis points (8250 = 82.50%); null gives a blank cell. */
export function percent(bps: number | null): Cell {
  if (bps === null) return null;
  assertSafeInteger(bps, "Basis points");
  return { kind: "percent", bps };
}

export function integer(value: number | null): Cell {
  if (value === null) return null;
  assertSafeInteger(value, "Integer");
  return { kind: "integer", value };
}

/** A multiple in basis points of "x" (10000 = 1.00x); null gives a blank cell. */
export function multiple(bps: number | null): Cell {
  if (bps === null) return null;
  assertSafeInteger(bps, "Multiple basis points");
  return { kind: "multiple", bps };
}

/** Units in micro-units (1_000_000 = 1 unit); null gives a blank cell. */
export function units(micro: number | null): Cell {
  if (micro === null) return null;
  assertSafeInteger(micro, "Micro-units");
  return { kind: "units", micro };
}

/** References and the one function the workbook code writes: `F7`, `SUM(C7:F7)`. */
const SAFE_FORMULA =
  /^(?:[A-Z]{1,3}[1-9]\d{0,6}|SUM\([A-Z]{1,3}[1-9]\d{0,6}:[A-Z]{1,3}[1-9]\d{0,6}\))$/;

/** A formula cell with its cached result; refuses anything but a cell reference or a SUM of a range. */
export function formula(expression: string, result: Cell): Cell {
  if (!SAFE_FORMULA.test(expression)) {
    throw new Error(`Not a formula the workbook writes: ${expression}`);
  }
  if (
    result === null ||
    result.kind === "text" ||
    result.kind === "date" ||
    result.kind === "formula"
  ) {
    throw new Error("A formula caches a number result");
  }
  return { kind: "formula", formula: expression, result };
}

/** The kind that decides a cell's number format (a formula: its result's). */
export function valueKind(cell: Cell): CellKind | null {
  if (cell === null) return null;
  return cell.kind === "formula" ? cell.result.kind : cell.kind;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Year, month (1–12) and day of a valid "YYYY-MM-DD", or null. */
export function parseYmd(
  ymd: string,
): { year: number; month: number; day: number } | null {
  const m = YMD.exec(ymd);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** A calendar date; null gives a blank cell. */
export function date(ymd: string | null): Cell {
  if (ymd === null) return null;
  if (parseYmd(ymd) === null) throw new Error(`Not a date: ${ymd}`);
  return { kind: "date", ymd };
}

/**
 * The cell's value as Excel stores it: dollars, a fraction, or a date at UTC
 * midnight (ExcelJS converts a Date to a serial day from its UTC time, so the
 * calendar day never shifts with the server's zone).
 */
export function cellValue(
  cell: Cell,
): string | number | Date | { formula: string; result: number } | null {
  if (cell === null) return null;
  switch (cell.kind) {
    case "formula":
      return {
        formula: cell.formula,
        result: cellValue(cell.result) as number,
      };
    case "multiple":
      return cell.bps / 10_000;
    case "units":
      return cell.micro / 1_000_000;
    case "text":
      return cell.value;
    case "money":
      // One division of an exact integer: the nearest double to the decimal.
      return cell.cents / 100;
    case "percent":
      return cell.bps / 10_000;
    case "integer":
      return cell.value;
    case "date": {
      const p = parseYmd(cell.ymd);
      if (!p) throw new Error(`Not a date: ${cell.ymd}`);
      return new Date(Date.UTC(p.year, p.month - 1, p.day));
    }
  }
}

// ---------------------------------------------------------------------------
// Number formats (one place, used by the renderer and asserted by its test)

export const NUMBER_FORMATS = {
  money: '"$"#,##0.00;[Red]("$"#,##0.00)',
  percent: "0.00%",
  date: "mmm d, yyyy",
  integer: "#,##0",
  multiple: '0.00"x"',
  units: "#,##0.00####",
} as const;

export function numberFormat(kind: CellKind): string | null {
  return kind === "text" ? null : NUMBER_FORMATS[kind];
}

// ---------------------------------------------------------------------------
// Names

/** Excel forbids these in sheet names. */
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g;

/**
 * A valid sheet name: forbidden characters removed, no leading or trailing
 * apostrophe, at most 31 characters, never empty.
 */
export function sheetName(raw: string): string {
  const cleaned = cleanText(raw)
    .replace(SHEET_NAME_FORBIDDEN, "")
    .replace(/[\t\r\n]/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim()
    .replace(/'+$/, "");
  return cleaned === "" ? "Sheet" : cleaned;
}

/**
 * `{parts joined by "-"}.xlsx` reduced to ASCII letters, digits, dashes and
 * dots (no path separators, quotes or header-breaking characters).
 */
export function workbookFileName(parts: string[]): string {
  const base = parts
    .map((p) =>
      p
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9.]+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, ""),
    )
    .filter((p) => p !== "")
    .join("-")
    .replace(/-{2,}/g, "-")
    .slice(0, 120)
    .replace(/[-.]+$/, "");
  return `${base === "" ? "export" : base}.xlsx`;
}

// ---------------------------------------------------------------------------
// Layout (row numbers are 1-based, as in Excel)

export interface SheetLayout {
  /** Row of the column headers (frozen, repeated when printed). */
  headerRow: number;
  /** First and last table row; `lastRow < firstRow` when the table is empty. */
  firstRow: number;
  lastRow: number;
  /** Row of the totals, or null. */
  totalsRow: number | null;
}

export function sheetLayout(sheet: SheetModel): SheetLayout {
  // Title block, one empty row, then the header.
  const headerRow = sheet.heading.length + 2;
  const firstRow = headerRow + 1;
  const lastRow = headerRow + sheet.rows.length;
  const totalsRow = sheet.totals && sheet.rows.length > 0 ? lastRow + 1 : null;
  return { headerRow, firstRow, lastRow, totalsRow };
}

/** "A", "B", …, "Z", "AA", … for a 0-based column index. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface TotalCell {
  column: number;
  formula: string;
  /** Cached result in the cell's own unit (dollars for money). */
  result: number;
  kind: "money" | "integer";
}

/**
 * The total cells of a sheet: a SUM over the table rows of each listed column
 * and its result, summed in integers (cents) and divided once. Cells of
 * another kind in that column (blank, text) count as nothing, as in SUM.
 */
export function sheetTotals(sheet: SheetModel): TotalCell[] {
  const layout = sheetLayout(sheet);
  if (!sheet.totals || layout.totalsRow === null) return [];
  return sheet.totals.columns.map((column) => {
    const col = sheet.columns[column];
    if (!col || (col.kind !== "money" && col.kind !== "integer")) {
      throw new Error(
        `Totals column ${column} is not a money or integer column`,
      );
    }
    let sum = 0;
    for (const row of sheet.rows) {
      let cell = row.cells[column] ?? null;
      if (cell?.kind === "formula") cell = cell.result;
      if (cell?.kind === "money") sum += cell.cents;
      else if (cell?.kind === "integer") sum += cell.value;
    }
    assertSafeInteger(sum, "Total");
    const letter = columnLetter(column);
    return {
      column,
      formula: `SUM(${letter}${layout.firstRow}:${letter}${layout.lastRow})`,
      result: col.kind === "money" ? sum / 100 : sum,
      kind: col.kind,
    };
  });
}

/** Tables of more than five rows get an auto-filter (5.7). */
export const AUTO_FILTER_MIN_ROWS = 6;
