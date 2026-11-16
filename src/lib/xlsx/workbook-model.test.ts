import { describe, expect, test } from "vitest";
import {
  cellValue,
  cleanText,
  columnLetter,
  date,
  formula,
  integer,
  money,
  multiple,
  NUMBER_FORMATS,
  numberFormat,
  parseYmd,
  percent,
  type SheetModel,
  sheetLayout,
  sheetName,
  sheetTotals,
  text,
  units,
  valueKind,
  workbookFileName,
} from "./workbook-model";

describe("cells", () => {
  test("money is integer cents, divided once", () => {
    expect(cellValue(money(123_456))).toBe(1234.56);
    expect(cellValue(money(-5))).toBe(-0.05);
    expect(cellValue(money(10))).toBe(0.1);
    expect(money(null)).toBeNull();
    expect(() => money(1.5)).toThrow();
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  test("percent is basis points", () => {
    expect(cellValue(percent(8250))).toBe(0.825);
    expect(cellValue(percent(0))).toBe(0);
    expect(percent(null)).toBeNull();
    expect(() => percent(12.5)).toThrow();
  });

  test("multiples and units", () => {
    expect(cellValue(multiple(1200))).toBe(0.12);
    expect(cellValue(units(12_345_678))).toBe(12.345678);
    expect(multiple(null)).toBeNull();
    expect(() => units(0.5)).toThrow();
    expect(numberFormat("multiple")).toBe('0.00"x"');
    expect(numberFormat("units")).toBe("#,##0.00####");
  });

  test("formulas: only references and SUM of a range, with a number result", () => {
    const f = formula("SUM(C7:F7)", money(1_000));
    expect(cellValue(f)).toEqual({ formula: "SUM(C7:F7)", result: 10 });
    expect(valueKind(f)).toBe("money");
    expect(cellValue(formula("F7", multiple(1250)))).toEqual({
      formula: "F7",
      result: 0.125,
    });
    for (const bad of [
      "=1+1",
      "SUM(A1)",
      "HYPERLINK(A1)",
      "A0",
      "a1",
      "C7:F7",
    ]) {
      expect(() => formula(bad, money(1))).toThrow();
    }
    expect(() => formula("A1", text("x"))).toThrow();
    expect(() => formula("A1", null)).toThrow();
  });

  test("integers", () => {
    expect(cellValue(integer(42))).toBe(42);
    expect(() => integer(0.5)).toThrow();
  });

  test("a date is UTC midnight of the calendar day", () => {
    const d = cellValue(date("2026-09-30")) as Date;
    expect(d.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(date(null)).toBeNull();
    expect(() => date("2026-02-30")).toThrow();
    expect(() => date("30/09/2026")).toThrow();
    expect(parseYmd("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseYmd("2025-02-29")).toBeNull();
  });

  test("text stays the literal string, formulas included", () => {
    expect(cellValue(text("=1+1"))).toBe("=1+1");
    expect(cellValue(text("+SUM(A1)"))).toBe("+SUM(A1)");
    expect(cellValue(text("@cmd"))).toBe("@cmd");
    expect(cellValue(text("\t-2"))).toBe("\t-2");
  });

  test("characters XML forbids are removed; tab, LF and CR kept", () => {
    expect(cleanText("a\u0000b\u0007c\u001Fd")).toBe("abcd");
    expect(cleanText("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    expect(cleanText("x\uD800y")).toBe("xy");
    expect(cleanText("ok 😀")).toBe("ok 😀");
    expect(cleanText("x".repeat(40_000)).length).toBe(32_767);
  });

  test("number formats", () => {
    expect(numberFormat("money")).toBe('"$"#,##0.00;[Red]("$"#,##0.00)');
    expect(numberFormat("percent")).toBe("0.00%");
    expect(numberFormat("date")).toBe("mmm d, yyyy");
    expect(numberFormat("integer")).toBe("#,##0");
    expect(numberFormat("text")).toBeNull();
    expect(NUMBER_FORMATS.money).toContain("[Red]");
  });
});

describe("names", () => {
  test("sheetName removes forbidden characters and cuts to 31", () => {
    expect(sheetName("Q3 [2026]: a/b\\c*d?e")).toBe("Q3 2026 abcde");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("'quoted'")).toBe("quoted");
    expect(sheetName("[]:*?/\\")).toBe("Sheet");
    expect(sheetName("Manager payments")).toBe("Manager payments");
  });

  test("workbookFileName keeps letters, digits, dashes and dots", () => {
    expect(
      workbookFileName(["Acme GPU Fund, LLC", "Q3 2026 report", "2026-09-30"]),
    ).toBe("Acme-GPU-Fund-LLC-Q3-2026-report-2026-09-30.xlsx");
    expect(workbookFileName(['Café / "x"', "../../etc", ""])).toBe(
      "Cafe-x-etc.xlsx",
    );
    expect(workbookFileName(["", "!!!"])).toBe("export.xlsx");
    expect(workbookFileName(["a\r\nContent-Type: x"])).toBe(
      "a-Content-Type-x.xlsx",
    );
  });

  test("columnLetter", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
  });
});

function sheet(rows: number[], heading = 3): SheetModel {
  return {
    name: "T",
    heading: Array.from({ length: heading }, (_, i) => ({
      text: `h${i}`,
      style: "meta" as const,
    })),
    columns: [
      { header: "Item", width: 20, kind: "text" },
      { header: "Amount", width: 15, kind: "money" },
    ],
    rows: rows.map((c, i) => ({ cells: [text(`r${i}`), money(c)] })),
    totals: { label: "Total", columns: [1] },
  };
}

describe("layout and totals", () => {
  test("header follows the title block and one empty row", () => {
    expect(sheetLayout(sheet([1, 2, 3]))).toEqual({
      headerRow: 5,
      firstRow: 6,
      lastRow: 8,
      totalsRow: 9,
    });
  });

  test("an empty table has no totals row", () => {
    const layout = sheetLayout(sheet([]));
    expect(layout.totalsRow).toBeNull();
    expect(sheetTotals(sheet([]))).toEqual([]);
  });

  test("the total is SUM over the table with the integer result", () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004; in cents it is 30.
    const totals = sheetTotals(sheet([10, 20]));
    expect(totals).toEqual([
      { column: 1, formula: "SUM(B6:B7)", result: 0.3, kind: "money" },
    ]);
    const many = sheetTotals(sheet(Array.from({ length: 100 }, () => 1)));
    expect(many[0]?.result).toBe(1);
    const negative = sheetTotals(sheet([-12_345, 345]));
    expect(negative[0]?.result).toBe(-120);
  });

  test("blank and text cells count as nothing", () => {
    const s = sheet([500]);
    s.rows.push({ cells: [text("x"), null] });
    s.rows.push({ cells: [text("y"), text("n/a")] });
    expect(sheetTotals(s)[0]).toMatchObject({
      formula: "SUM(B6:B8)",
      result: 5,
    });
  });

  test("a total on a text column is refused", () => {
    const s = sheet([1]);
    s.totals = { label: "Total", columns: [0] };
    expect(() => sheetTotals(s)).toThrow();
  });
});
