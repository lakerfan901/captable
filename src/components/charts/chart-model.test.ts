import { describe, expect, it } from "vitest";
import {
  aggregate,
  type FundPeriodValues,
} from "../../lib/llc/financial-series";
import { buildSeries } from "../../lib/llc/financial-series-build";
import { generateWorld } from "../../lib/llc/fixtures/series-world";
import {
  breakdownSeries,
  breakdownValue,
  buildPeriodRows,
  OTHER_KEY,
  partialOf,
  type SeriesSpec,
  shareParts,
  shortPeriodLabel,
  stackRoles,
  tableModel,
  toggleHidden,
  tooltipModel,
  tooltipSentence,
  visibleSeries,
  waterfall,
} from "./chart-model";

const world = generateWorld(11, { months: 20 });
const { fundMonths } = buildSeries(world.input, {
  from: world.inception,
  to: world.lastMonth,
});

const REV: SeriesSpec<FundPeriodValues>[] = [
  {
    key: "rev",
    label: "Revenue",
    mark: "bar",
    unit: "cents",
    slot: 1,
    rule: "sum",
    get: (v) => v.grossRevenue,
  },
  {
    key: "paid",
    label: "Paid-in",
    mark: "line",
    unit: "cents",
    slot: 2,
    rule: "end",
    get: (v) => v.paidInCapital,
  },
  {
    key: "util",
    label: "Utilization",
    mark: "line",
    unit: "bps",
    slot: 3,
    rule: "mean",
    get: (v) => v.utilizationBps,
  },
];

describe("labels", () => {
  it("short axis labels", () => {
    expect(shortPeriodLabel("2027-Q2")).toBe("Q2 ’27");
    expect(shortPeriodLabel("2027-01")).toBe("Jan ’27");
    expect(shortPeriodLabel("2027-02")).toBe("Feb");
    expect(shortPeriodLabel("2027")).toBe("2027");
    expect(shortPeriodLabel("inception")).toBe("All");
  });
  it("partial periods say why", () => {
    const q = ["2027-04-01", "2027-05-01", "2027-06-01"];
    const base = { months: q, partial: true, inProgress: false };
    const cutEnd = {
      ...base,
      rangeMonths: q.slice(0, 2),
      presentMonths: q.slice(0, 2),
    };
    expect(partialOf(cutEnd)?.suffix).toBe("to date");
    expect(partialOf(cutEnd)?.note).toBe("2 of 3 months so far");
    expect(
      partialOf({ ...base, rangeMonths: q.slice(1), presentMonths: q.slice(1) })
        ?.suffix,
    ).toBe("from May");
    // a missing month inside the range is a gap, never "from" / "to date"
    expect(
      partialOf({ ...base, rangeMonths: q, presentMonths: q.slice(1) })?.suffix,
    ).toBe("(2 of 3 months)");
    expect(
      partialOf({ ...base, rangeMonths: q, presentMonths: q.slice(0, 2) })
        ?.suffix,
    ).toBe("(2 of 3 months)");
    expect(
      partialOf({
        ...base,
        rangeMonths: q,
        presentMonths: [q[0] as string, q[2] as string],
      })?.suffix,
    ).toBe("(2 of 3 months)");
    expect(
      partialOf({ ...base, rangeMonths: q, presentMonths: [] })?.suffix,
    ).toBe("(no figures)");
    expect(
      partialOf({ ...base, rangeMonths: q, presentMonths: q, inProgress: true })
        ?.suffix,
    ).toBe("to date");
    expect(
      partialOf({ ...base, partial: false, rangeMonths: q, presentMonths: q }),
    ).toBeNull();
  });
});

describe("rows, tooltip and table", () => {
  const periods = aggregate(fundMonths, "quarter", {
    from: "2026-07-01",
    to: world.lastMonth,
  });
  const rows = buildPeriodRows(periods, REV);

  it("a period before inception is a gap (null), never a zero", () => {
    const q3 = rows.find((r) => r.key === "2026-Q3");
    expect(q3?.hasData).toBe(false);
    expect(q3?.plot.rev).toBeNull();
    expect(q3?.raw.paid).toBeNull();
  });

  it("the first quarter starts at inception and is labelled so", () => {
    // the dashboard's ranges start at inception (period-state clamps them)
    const fromInception = buildPeriodRows(
      aggregate(fundMonths, "quarter", {
        from: world.inception,
        to: world.lastMonth,
      }),
      REV,
    );
    const q4 = fromInception.find((r) => r.key === "2026-Q4");
    expect(q4?.partial).toBe(true);
    expect(q4?.label).toBe("Q4 2026 from Nov");
  });

  it("plots the raw cents exactly", () => {
    for (const [i, r] of rows.entries()) {
      const p = periods[i];
      if (!p?.values) continue;
      expect(r.plot.rev).toBe(Number(p.values.grossRevenue));
      expect(r.raw.rev).toBe(p.values.grossRevenue);
    }
  });

  it("tooltip values equal table cells for every row", () => {
    const t = tableModel(rows, REV);
    for (const [i, r] of rows.entries()) {
      const tip = tooltipModel(r, REV);
      expect(t.rows[i]?.cells).toEqual(tip.lines.map((l) => l.value));
      expect(t.rows[i]?.label).toBe(tip.title);
    }
  });

  it("the totals row sums only summed series", () => {
    const t = tableModel(rows, REV);
    const sum = periods.reduce(
      (a, p) => a + (p.values?.grossRevenue ?? 0n),
      0n,
    );
    expect(t.totals?.[0]).toBe(
      `$${(sum / 100n).toLocaleString("en-US")}.${(sum % 100n).toString().padStart(2, "0")}`,
    );
    expect(t.totals?.[1]).toBe("");
    expect(t.totals?.[2]).toBe("");
  });

  it("stacked charts get a total in the tooltip and a total column", () => {
    const stacked = REV.slice(0, 2).map((s) => ({
      ...s,
      stack: "a",
      rule: "sum" as const,
    }));
    const row = rows[rows.length - 1];
    if (!row) throw new Error("no rows");
    const tip = tooltipModel(row, stacked);
    const v = periods[periods.length - 1]?.values as FundPeriodValues;
    expect(tip.total?.value).toBe(
      tooltipModel({ ...row, raw: { rev: v.grossRevenue + v.paidInCapital } }, [
        REV[0] as SeriesSpec<FundPeriodValues>,
      ]).lines[0]?.value,
    );
    const t = tableModel(rows, stacked);
    expect(t.columns.map((c) => c.label)).toEqual([
      "Revenue",
      "Paid-in",
      "Total",
    ]);
    expect(tooltipSentence(tip)).toContain("Total");
  });
});

describe("legend toggles", () => {
  it("hides and shows, never the last one", () => {
    const keys = ["a", "b"];
    let h = toggleHidden(new Set(), "a", keys);
    expect([...h]).toEqual(["a"]);
    h = toggleHidden(h, "b", keys);
    expect([...h]).toEqual(["a"]);
    h = toggleHidden(h, "a", keys);
    expect([...h]).toEqual([]);
    expect(visibleSeries(REV, new Set(["paid"])).map((s) => s.key)).toEqual([
      "rev",
      "util",
    ]);
  });
});

describe("stack roles", () => {
  it("caps the outermost segment on each side and gaps all but the first", () => {
    const roles = stackRoles(
      [
        {
          key: "r",
          label: "",
          short: "",
          grain: "month",
          hasData: true,
          partial: false,
          inProgress: false,
          partialNote: null,
          raw: {},
          plot: { a: 5, b: 0, c: 3, d: -2, e: null, f: -1 },
        },
      ],
      ["a", "b", "c", "d", "e", "f"].map((key) => ({ key })),
    ).get("r");
    expect(roles).toEqual({
      a: { cap: false, gap: false },
      c: { cap: true, gap: true },
      d: { cap: false, gap: false },
      f: { cap: true, gap: true },
    });
  });
});

describe("breakdowns", () => {
  const thirteen = new Map(
    [
      "COLOCATION",
      "POWER",
      "NETWORK",
      "INSURANCE",
      "REPAIR_AND_REPLACEMENT",
      "SOFTWARE_AND_SUPPORT",
      "PROFESSIONAL_FEES",
      "TAXES_AND_FILING_FEES",
      "BANK_FEES",
      "ORGANIZATIONAL_OFFERING",
      "EQUIPMENT_ACQUISITION",
      "DEFAULT_COLLECTION",
      "OTHER",
    ].map((k, i) => [k, BigInt((13 - i) * 1000)]),
  );
  const humanize = (s: string) => s.toLowerCase();

  it("folds past eight into Other, by identity", () => {
    const b = breakdownSeries(thirteen, humanize);
    expect(b).toHaveLength(8);
    expect(b.slice(0, 7).map((x) => x.key)).toEqual([
      "COLOCATION",
      "POWER",
      "NETWORK",
      "INSURANCE",
      "REPAIR_AND_REPLACEMENT",
      "SOFTWARE_AND_SUPPORT",
      "PROFESSIONAL_FEES",
    ]);
    expect(b.map((x) => x.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const other = b[7];
    expect(other?.key).toBe(OTHER_KEY);
    expect(other?.members).toHaveLength(6);
    expect(
      breakdownValue(
        [...thirteen].map(([label, amount]) => ({ label, amount })),
        other?.members ?? [],
      ),
    ).toBe(BigInt((6 + 5 + 4 + 3 + 2 + 1) * 1000));
  });

  it("keeps every label when there are eight or fewer; a missing list is a gap", () => {
    const five = new Map([...thirteen].slice(0, 5));
    expect(breakdownSeries(five, humanize).map((x) => x.key)).not.toContain(
      OTHER_KEY,
    );
    expect(breakdownValue(null, ["A"])).toBeNull();
    expect(breakdownValue([], ["A"])).toBe(0n);
  });

  it("colours do not depend on the window: same totals, same slots", () => {
    const a = breakdownSeries(thirteen, humanize);
    const b = breakdownSeries(new Map([...thirteen].reverse()), humanize);
    expect(a).toEqual(b);
  });
});

describe("share of a whole", () => {
  it("shares of the positive total, largest first; negatives draw nothing", () => {
    const s = shareParts([
      { key: "a", label: "A", slot: 1, amount: 2500n },
      { key: "b", label: "B", slot: 2, amount: 7500n },
      { key: "c", label: "C", slot: 3, amount: -100n },
    ]);
    expect(s.parts.map((p) => [p.key, p.share, p.width])).toEqual([
      ["b", "75.0%", 75],
      ["a", "25.0%", 25],
      ["c", "0.0%", 0],
    ]);
    expect(s.total).toBe("$99.00");
  });
});

describe("waterfall", () => {
  it("adds up to the change with a remainder step", () => {
    const steps = waterfall(
      [
        { key: "in", label: "In", amount: 1000n },
        { key: "out", label: "Out", amount: -300n },
      ],
      500n,
      { other: "Other", change: "Change" },
    );
    expect(steps.map((s) => [s.key, s.from, s.to, s.kind])).toEqual([
      ["in", 0n, 1000n, "in"],
      ["out", 1000n, 700n, "out"],
      ["other", 700n, 500n, "out"],
      ["change", 0n, 500n, "total"],
    ]);
  });
  it("no remainder step when the movements explain the change; negative totals", () => {
    const steps = waterfall(
      [{ key: "out", label: "Out", amount: -300n }],
      -300n,
      { other: "Other", change: "Change" },
    );
    expect(steps.map((s) => s.key)).toEqual(["out", "change"]);
    expect(steps[1]?.to).toBe(-300n);
  });
});
