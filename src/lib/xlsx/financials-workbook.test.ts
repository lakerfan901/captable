import { describe, expect, it } from "vitest";
import {
  FUND_TILES,
  HOLDER_TILES,
} from "../../components/financials/dashboard-model";
import {
  type MonthKey,
  monthEnd,
  monthsBetween,
  periodLabel,
} from "../llc/financial-periods";
import {
  aggregate,
  aggregateHolder,
  type FundMonth,
  holderSlice,
} from "../llc/financial-series";
import { buildSeries } from "../llc/financial-series-build";
import { generateWorld } from "../llc/fixtures/series-world";
import {
  type FinancialsWorkbookInput,
  financialsWorkbook,
} from "./financials-workbook";
import {
  type Cell,
  cellValue,
  NUMBER_FORMATS,
  type SheetModel,
  sheetLayout,
  sheetTotals,
} from "./workbook-model";

const world = generateWorld(5, { months: 19 });
const all = { from: world.inception, to: world.lastMonth };
const { fundMonths, holderMonths } = buildSeries(world.input, all);
const B = holderSlice(holderMonths, "B");
const year2027 = { from: "2027-01-01", to: "2027-12-01" };

function input(
  over: Partial<FinancialsWorkbookInput> = {},
): FinancialsWorkbookInput {
  return {
    companyName: "Acme Compute LLC",
    view: "fund",
    source: "portal",
    publishedThrough: monthEnd(world.lastMonth),
    inceptionMonth: world.inception,
    fundMonths,
    holderMonths: [],
    restatements: [],
    targetSaleDate: null,
    grain: "quarter",
    from: year2027.from,
    to: year2027.to,
    focus: "2027-Q4",
    compare: "previous",
    ...over,
  };
}

function sheet(model: { sheets: SheetModel[] }, name: string): SheetModel {
  const s = model.sheets.find((x) => x.name === name);
  if (!s) throw new Error(`no sheet ${name}`);
  return s;
}

function rowOf(s: SheetModel, label: string) {
  const r = s.rows.find(
    (x) => x.cells[0]?.kind === "text" && x.cells[0].value === label,
  );
  if (!r) throw new Error(`no row ${label} in ${s.name}`);
  return r;
}

const cents = (c: Cell): number | null => {
  if (c === null) return null;
  if (c.kind === "money") return c.cents;
  if (c.kind === "formula" && c.result.kind === "money") return c.result.cents;
  throw new Error(`not money: ${JSON.stringify(c)}`);
};

describe("sheets", () => {
  it("fund view: Summary, Income, Expenses, Distributions, Capital; no holder sheet", () => {
    const m = financialsWorkbook(input());
    expect(m.sheets.map((s) => s.name)).toEqual([
      "Summary",
      "Income",
      "Expenses",
      "Distributions",
      "Capital",
    ]);
  });

  it("mine view: Summary, My investment, My distributions, My contributions", () => {
    const m = financialsWorkbook(
      input({ view: "mine", holderMonths: B, focus: "2027-Q4" }),
    );
    expect(m.sheets.map((s) => s.name)).toEqual([
      "Summary",
      "My investment",
      "My distributions",
      "My contributions",
    ]);
  });

  it("every sheet freezes the header and the row labels; titles name the company", () => {
    for (const view of ["fund", "mine"] as const) {
      const m = financialsWorkbook(input({ view, holderMonths: B }));
      for (const s of m.sheets) {
        expect(s.freezeColumns).toBe(1);
        expect(s.heading[0]?.style).toBe("title");
        expect(s.heading[0]?.text.startsWith("Acme Compute LLC: ")).toBe(true);
      }
    }
  });

  it("file name and properties are fixed by the view, not by the clock", () => {
    const m = financialsWorkbook(input());
    expect(m.fileName).toBe(
      "Acme-Compute-LLC-financials-2027-Q1-to-2027-Q4.xlsx",
    );
    expect(m.createdAt.toISOString()).toBe(
      `${monthEnd(world.lastMonth)}T00:00:00.000Z`,
    );
    expect(financialsWorkbook(input())).toEqual(m);
  });
});

describe("Last 4 quarters", () => {
  const m = financialsWorkbook(input());
  const income = sheet(m, "Income");
  const quarters = aggregate(fundMonths, "quarter", year2027, {
    inceptionMonth: world.inception,
  });
  const [fy] = aggregate(fundMonths, "year", year2027, {
    inceptionMonth: world.inception,
  });

  it("one column per quarter, then Total", () => {
    expect(income.columns.map((c) => c.header)).toEqual([
      "Figure",
      "Basis",
      "Q1 2027",
      "Q2 2027",
      "Q3 2027",
      "Q4 2027",
      "Total",
    ]);
  });

  it("the quarter cells equal aggregate; the Total is a SUM whose result equals aggregate for the range", () => {
    const layout = sheetLayout(income);
    const i = income.rows.findIndex(
      (r) =>
        r.cells[0]?.kind === "text" && r.cells[0].value === "Gross Revenue",
    );
    const row = income.rows[i];
    if (!row || !fy?.values) throw new Error("fixture");
    quarters.forEach((q, k) => {
      expect(cents(row.cells[2 + k] ?? null)).toBe(
        Number(q.values?.grossRevenue),
      );
    });
    const total = row.cells[6];
    expect(total?.kind).toBe("formula");
    if (total?.kind !== "formula") throw new Error("formula");
    expect(total.formula).toBe(
      `SUM(C${layout.firstRow + i}:F${layout.firstRow + i})`,
    );
    expect(cents(total)).toBe(Number(fy.values.grossRevenue));
    expect(cellValue(total)).toEqual({
      formula: total.formula,
      result: Number(fy.values.grossRevenue) / 100,
    });
    for (const label of [
      "Operating expenses",
      "Management Fee accrued",
      "Net operating income (before reserves and distributions)",
    ]) {
      const r = rowOf(income, label);
      const key =
        label === "Operating expenses"
          ? "operatingExpenses"
          : label === "Management Fee accrued"
            ? "managementFeeAccrued"
            : "netOperatingIncome";
      expect(cents(r.cells[6] ?? null)).toBe(
        Number(fy.values[key as "operatingExpenses"]),
      );
    }
  });

  it("a balance's Total is the last quarter's value (a reference), equal to the year end", () => {
    const r = rowOf(income, "Available Cash");
    const total = r.cells[6];
    expect(total?.kind === "formula" && /^F\d+$/.test(total.formula)).toBe(
      true,
    );
    expect(cents(total ?? null)).toBe(Number(fy?.values?.availableCash));
    const cap = sheet(m, "Capital");
    expect(cents(rowOf(cap, "Paid-in capital").cells[6] ?? null)).toBe(
      Number(fy?.values?.paidInCapital),
    );
    const dpi = rowOf(cap, "DPI (Preferred class)").cells[6];
    expect(dpi?.kind === "formula" && dpi.result.kind === "multiple").toBe(
      true,
    );
  });

  it("distributions: the tiers and the total per quarter; the Total equals the year", () => {
    const d = sheet(m, "Distributions");
    const gross = rowOf(d, "Distributions paid");
    quarters.forEach((q, k) => {
      expect(cents(gross.cells[2 + k] ?? null)).toBe(
        Number(q.values?.distributions.gross),
      );
    });
    expect(cents(gross.cells[6] ?? null)).toBe(
      Number(fy?.values?.distributions.gross),
    );
    expect(gross.strong).toBe(true);
  });

  it("expenses: a row per category, a Total column and a totals row equal to the year's expenses", () => {
    const e = sheet(m, "Expenses");
    const totals = sheetTotals(e);
    const totalOfTotals = totals.find((t) => t.column === 6);
    const yearByCategory = fy?.values?.expensesByCategory ?? [];
    const sumYear = yearByCategory.reduce((n, c) => n + c.amount, 0n);
    expect(totalOfTotals?.result).toBe(Number(sumYear) / 100);
    expect(e.rows.length).toBe(yearByCategory.length);
    quarters.forEach((q, k) => {
      const col = totals.find((t) => t.column === 2 + k);
      const qSum = (q.values?.expensesByCategory ?? []).reduce(
        (n, c) => n + c.amount,
        0n,
      );
      expect(col?.result).toBe(Number(qSum) / 100);
    });
  });
});

describe("range, partial periods and the published-through date", () => {
  it("a range past the last month is cut: no column and no figure after it", () => {
    const through: MonthKey = "2027-08-01";
    const visible = fundMonths.filter((x) => x.month <= through);
    const m = financialsWorkbook(
      input({
        fundMonths: visible,
        publishedThrough: monthEnd(through),
        from: "2027-01-01",
        to: "2029-12-01",
        focus: "2028-Q2",
      }),
    );
    const income = sheet(m, "Income");
    expect(income.columns.slice(2).map((c) => c.header)).toEqual([
      "Q1 2027",
      "Q2 2027",
      "Q3 2027 (2 of 3 months)",
      "Total",
    ]);
    // the focus outside the months that exist falls back to the last column
    expect(sheet(m, "Summary").columns[1]?.header).toBe("Q3 2027");
    const q3 = aggregate(visible, "quarter", {
      from: "2027-07-01",
      to: through,
    })[0];
    expect(cents(rowOf(income, "Gross Revenue").cells[4] ?? null)).toBe(
      Number(q3?.values?.grossRevenue),
    );
    const later = fundMonths.find((x) => x.month === "2027-09-01") as FundMonth;
    expect(cents(rowOf(income, "Gross Revenue").cells[4] ?? null)).not.toBe(
      Number(q3?.values?.grossRevenue ?? 0n) + Number(later.grossRevenue),
    );
  });

  it("an empty range is refused", () => {
    expect(() =>
      financialsWorkbook(input({ from: "2030-01-01", to: "2030-03-01" })),
    ).toThrow(/No published month/);
    expect(() => financialsWorkbook(input({ fundMonths: [] }))).toThrow(
      /No months/,
    );
  });

  it("months: one column per month, the month in progress marked", () => {
    const ip = fundMonths.map((x, i) =>
      i === fundMonths.length - 1 ? { ...x, inProgress: true } : x,
    );
    const m = financialsWorkbook(
      input({
        fundMonths: ip,
        source: "live",
        grain: "month",
        from: "2028-01-01",
        to: world.lastMonth,
        focus: null,
      }),
    );
    const headers = sheet(m, "Income")
      .columns.slice(2)
      .map((c) => c.header);
    expect(headers).toEqual([
      ...monthsBetween("2028-01-01", "2028-04-01").map((x) =>
        periodLabel(x.slice(0, 7)),
      ),
      "May 2028 (in progress)",
      "Total",
    ]);
    expect(
      sheet(m, "Summary").heading.some((h) => /in progress/.test(h.text)),
    ).toBe(true);
  });

  it("utilization: the Total is the mean of the months, not the mean of the quarters", () => {
    const range = { from: "2026-11-01", to: "2027-03-01" };
    // Nov and Dec 2026 (Q4, two months) at 100%, Jan–Mar 2027 at 0%:
    // months average 40%, the two quarters 50%.
    const shaped = fundMonths.map((x) =>
      x.month < "2027-01-01"
        ? { ...x, utilizationBps: 10_000 }
        : x.month <= "2027-03-01"
          ? { ...x, utilizationBps: 0 }
          : x,
    );
    const m = financialsWorkbook(
      input({ ...range, fundMonths: shaped, focus: "2027-Q1" }),
    );
    const util = rowOf(
      sheet(m, "Income"),
      "Utilization (as reported by the Manager)",
    );
    expect(util.cells.slice(2)).toEqual([
      { kind: "percent", bps: 10_000 },
      { kind: "percent", bps: 0 },
      { kind: "percent", bps: 4_000 },
    ]);
  });
});

describe("Summary: the KPI tiles", () => {
  it("one row per tile with value, comparison, change and change %", () => {
    const m = financialsWorkbook(input());
    const s = sheet(m, "Summary");
    expect(s.columns.map((c) => c.header)).toEqual([
      "Figure",
      "Q4 2027",
      "Q3 2027",
      "Change",
      "Change %",
      "Notes",
    ]);
    const labels = s.rows.map((r) =>
      r.cells[0]?.kind === "text" ? r.cells[0].value : "",
    );
    const hasUtil = fundMonths.some((x) => x.utilizationBps !== null);
    expect(labels).toEqual(
      FUND_TILES.filter((d) => hasUtil || d.key !== "utilizationBps").map(
        (d) => d.label,
      ),
    );
    const [q4] = aggregate(fundMonths, "quarter", {
      from: "2027-10-01",
      to: "2027-12-01",
    });
    const [q3] = aggregate(fundMonths, "quarter", {
      from: "2027-07-01",
      to: "2027-09-01",
    });
    const rev = rowOf(s, "Gross Revenue");
    const a = Number(q4?.values?.grossRevenue);
    const b = Number(q3?.values?.grossRevenue);
    expect(rev.cells.slice(1, 4)).toEqual([
      { kind: "money", cents: a },
      { kind: "money", cents: b },
      { kind: "money", cents: a - b },
    ]);
    const pct = rev.cells[4];
    expect(pct?.kind).toBe("percent");
    const dpi = rowOf(s, "DPI (Preferred class)");
    expect(dpi.cells[1]?.kind).toBe("multiple");
    expect(NUMBER_FORMATS.multiple).toBe('0.00"x"');
  });

  it("no comparison: value and notes only", () => {
    const m = financialsWorkbook(input({ compare: "none" }));
    expect(sheet(m, "Summary").columns.map((c) => c.header)).toEqual([
      "Figure",
      "Q4 2027",
      "Notes",
    ]);
  });

  it("since inception: one value per tile, not compared", () => {
    const m = financialsWorkbook(input({ focus: "inception" }));
    const s = sheet(m, "Summary");
    expect(s.columns.map((c) => c.header)).toEqual([
      "Figure",
      "Since inception",
      "Notes",
    ]);
    const [inc] = aggregate(fundMonths, "inception", all, {
      inceptionMonth: world.inception,
    });
    expect(rowOf(s, "Gross Revenue").cells[1]).toEqual({
      kind: "money",
      cents: Number(inc?.values?.grossRevenue),
    });
  });

  it("the Target Sale Date tile is a month count", () => {
    const m = financialsWorkbook(input({ targetSaleDate: "2031-03-03" }));
    const r = rowOf(sheet(m, "Summary"), "Months to the Target Sale Date");
    expect(r.cells[1]).toEqual({ kind: "integer", value: 39 });
  });

  it("mine: the holder's tiles and units", () => {
    const m = financialsWorkbook(
      input({ view: "mine", holderMonths: B, focus: "2027-Q4" }),
    );
    const s = sheet(m, "Summary");
    const labels = s.rows.map((r) =>
      r.cells[0]?.kind === "text" ? r.cells[0].value : "",
    );
    for (const d of HOLDER_TILES) expect(labels).toContain(d.label);
    expect(labels).toContain("Preferred units");
    const calendar = fundMonths.map((x) => ({
      month: x.month,
      inProgress: x.inProgress,
    }));
    const [q4] = aggregateHolder(B, calendar, "quarter", {
      from: "2027-10-01",
      to: "2027-12-01",
    });
    expect(rowOf(s, "Paid in").cells[1]).toEqual({
      kind: "money",
      cents: Number(q4?.values?.paidIn),
    });
    expect(rowOf(s, "Preferred units").cells[1]).toEqual({
      kind: "units",
      micro: Number(q4?.values?.preferredUnits),
    });
  });
});

describe("My investment sheets", () => {
  const m = financialsWorkbook(
    input({ view: "mine", holderMonths: B, focus: "2027-Q4" }),
  );
  const calendar = fundMonths.map((x) => ({
    month: x.month,
    inProgress: x.inProgress,
  }));

  it("the holder's figures per quarter, the Total equal to the year", () => {
    const s = sheet(m, "My investment");
    const [fy] = aggregateHolder(B, calendar, "year", year2027);
    expect(cents(rowOf(s, "Distributions received").cells[6] ?? null)).toBe(
      Number(fy?.values?.grossDistributions),
    );
    expect(cents(rowOf(s, "Paid in").cells[6] ?? null)).toBe(
      Number(fy?.values?.paidIn),
    );
  });

  it("distributions and contributions by month, with totals", () => {
    const d = sheet(m, "My distributions");
    const withDist = B.filter(
      (x) =>
        x.grossDistributions !== 0n ||
        x.netPaid !== 0n ||
        x.defaultOffsets !== 0n ||
        x.taxAdvanceOffsets !== 0n,
    );
    expect(d.rows.length).toBe(withDist.length);
    const net = sheetTotals(d).find(
      (t) => d.columns[t.column]?.header === "Net paid",
    );
    expect(net?.result).toBe(
      Number(withDist.reduce((n, x) => n + x.netPaid, 0n)) / 100,
    );
    const c = sheet(m, "My contributions");
    const contributed = sheetTotals(c).find((t) => t.column === 1);
    expect(contributed?.result).toBe(
      Number(B.reduce((n, x) => n + x.contributions, 0n)) / 100,
    );
  });

  it("names nobody: no holder id or name in any cell or heading", () => {
    const json = JSON.stringify(m);
    for (const id of world.holderIds) {
      expect(json).not.toContain(`"${id}"`);
    }
    expect(json).not.toContain("Holder ");
  });

  it("the team's preview names the previewed holder", () => {
    const p = financialsWorkbook(
      input({
        view: "mine",
        holderMonths: B,
        source: "preview",
        holderName: "Holder B",
      }),
    );
    expect(p.sheets[0]?.heading[1]?.text).toBe(
      "What Holder B sees in the investor portal",
    );
  });
});
