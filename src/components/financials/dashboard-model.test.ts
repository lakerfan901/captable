import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregate,
  aggregateHolder,
  FUND_METRICS,
  type FundMonth,
  type FundPeriodValues,
  fundComparison,
  HOLDER_METRICS,
  holderSlice,
} from "../../lib/llc/financial-series";
import { buildSeries } from "../../lib/llc/financial-series-build";
import { generateWorld } from "../../lib/llc/fixtures/series-world";
import { formatValue } from "../charts/chart-format";
import {
  buildPeriodRows,
  OTHER_KEY,
  tableModel,
  tooltipModel,
} from "../charts/chart-model";
import {
  CAPITAL_SPEC,
  DISTRIBUTIONS_SPEC,
  expenseBreakdown,
  expensesSpec,
  hasUtilization,
  MY_CAPITAL_SPEC,
  MY_DISTRIBUTIONS_SPEC,
  PREFERRED_RETURN_SPEC,
  REVENUE_SPEC,
  reserveBreakdown,
  reservesSpec,
  UTILIZATION_SPEC,
} from "./chart-specs";
import {
  CASH_FLOW_CHANGE_LABEL,
  cashFlowSteps,
  FUND_TILES,
  HOLDER_TILES,
  tileViews,
  unitsTile,
} from "./dashboard-model";

const world = generateWorld(5, { months: 19 });
const range = { from: world.inception, to: world.lastMonth };
const { fundMonths, holderMonths } = buildSeries(world.input, range);
const quarters = aggregate(fundMonths, "quarter", range);

describe("chart specs come from the P12 catalogue", () => {
  it("every catalogue-keyed series uses the catalogue getter and rule", () => {
    const fundSpecs = [
      REVENUE_SPEC,
      DISTRIBUTIONS_SPEC,
      CAPITAL_SPEC,
      PREFERRED_RETURN_SPEC,
      UTILIZATION_SPEC,
    ];
    for (const spec of fundSpecs) {
      for (const s of [...spec.series, ...spec.extras]) {
        const def = FUND_METRICS.find((m) => m.key === s.key);
        expect(def, s.key).toBeDefined();
        expect(s.get).toBe(def?.get);
        if ("rule" in s) expect(s.rule).toBe(def?.rule);
      }
    }
    for (const spec of [MY_DISTRIBUTIONS_SPEC, MY_CAPITAL_SPEC]) {
      for (const s of [...spec.series, ...spec.extras]) {
        const def = HOLDER_METRICS.find((m) => m.key === s.key);
        expect(def, s.key).toBeDefined();
        expect(s.get).toBe(def?.get);
      }
    }
  });

  it("slots are unique within a chart", () => {
    const values = quarters.map((p) => p.values);
    for (const spec of [
      REVENUE_SPEC,
      DISTRIBUTIONS_SPEC,
      CAPITAL_SPEC,
      PREFERRED_RETURN_SPEC,
      MY_DISTRIBUTIONS_SPEC,
      MY_CAPITAL_SPEC,
      expensesSpec(expenseBreakdown(values)),
      reservesSpec(reserveBreakdown(values)),
    ]) {
      const slots = spec.series.map((s) => s.slot);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });

  it("the expense series add up to total expenses in every period", () => {
    const spec = expensesSpec(expenseBreakdown(quarters.map((p) => p.values)));
    for (const p of quarters) {
      if (!p.values) continue;
      const sum = spec.series.reduce(
        (a, s) => a + ((s.get(p.values as FundPeriodValues) as bigint) ?? 0n),
        0n,
      );
      expect(sum).toBe(p.values.totalExpenses);
    }
  });

  it("thirteen categories fold to seven and Other, still adding up", () => {
    const cats = [
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "B1",
      "B2",
      "B3",
      "B4",
    ];
    const v = {
      ...(quarters[1]?.values as FundPeriodValues),
      expensesByCategory: cats.map((category, i) => ({
        category,
        amount: BigInt(i + 1) * 100n,
      })),
    };
    const spec = expensesSpec(expenseBreakdown([v]));
    expect(spec.series).toHaveLength(8);
    expect(spec.series[7]?.key).toBe(OTHER_KEY);
    const sum = spec.series.reduce((a, s) => a + (s.get(v) as bigint), 0n);
    expect(sum).toBe(BigInt((13 * 14) / 2) * 100n);
  });

  it("the reserve kinds add up to the reserve balance; the minimum is its own line", () => {
    const spec = reservesSpec(reserveBreakdown(quarters.map((p) => p.values)));
    const kinds = spec.series.filter((s) => s.stack === "r");
    expect(spec.series[spec.series.length - 1]?.key).toBe("minimumReserve");
    for (const p of quarters) {
      if (!p.values) continue;
      const sum = kinds.reduce(
        (a, s) => a + ((s.get(p.values as FundPeriodValues) as bigint) ?? 0n),
        0n,
      );
      expect(sum).toBe(p.values.reserveBalance);
    }
  });

  it("utilization is shown only when a month has a value", () => {
    expect(hasUtilization(fundMonths)).toBe(true);
    expect(
      hasUtilization(fundMonths.map((m) => ({ ...m, utilizationBps: null }))),
    ).toBe(false);
  });

  it("a month without utilization is a gap in F8, not a zero", () => {
    const months = aggregate(fundMonths, "month", range);
    const rows = buildPeriodRows(months, UTILIZATION_SPEC.series);
    const gap = months.findIndex((m) => m.values?.utilizationBps === null);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(rows[gap]?.plot.utilizationBps).toBeNull();
    expect(
      tooltipModel(rows[gap] as never, UTILIZATION_SPEC.series).lines[0]?.value,
    ).toBe("—");
  });

  it("table and tooltip agree for every chart of the fixture", () => {
    const holder = holderSlice(holderMonths, "A");
    const mine = aggregateHolder(holder, fundMonths, "quarter", range);
    const cases = [
      [REVENUE_SPEC, quarters],
      [DISTRIBUTIONS_SPEC, quarters],
      [CAPITAL_SPEC, quarters],
      [PREFERRED_RETURN_SPEC, quarters],
      [MY_DISTRIBUTIONS_SPEC, mine],
      [MY_CAPITAL_SPEC, mine],
    ] as const;
    for (const [spec, periods] of cases) {
      const rows = buildPeriodRows(
        periods as never,
        spec.series as never,
        spec.extras as never,
      );
      const t = tableModel(rows, spec.series as never, spec.extras as never);
      for (const [i, r] of rows.entries()) {
        const tip = tooltipModel(r, spec.series as never, spec.extras as never);
        const expected = [
          ...tip.lines.map((l) => l.value),
          ...(tip.total
            ? [tip.total.value]
            : t.columns.some((c) => c.key === "__total")
              ? ["—"]
              : []),
          ...tip.extras.map((l) => l.value),
        ];
        expect(t.rows[i]?.cells).toEqual(expected);
      }
    }
  });
});

describe("tiles", () => {
  const cur = quarters[quarters.length - 2];
  const prev = quarters[quarters.length - 3];
  if (!cur || !prev) throw new Error("fixture too short");

  it("values and deltas against the previous quarter", () => {
    const tiles = tileViews(FUND_TILES, cur, prev, "Q1", quarters);
    const rev = tiles.find((t) => t.key === "grossRevenue");
    expect(rev?.value).toBe(
      formatValue("cents", cur.values?.grossRevenue ?? null),
    );
    const diff =
      (cur.values?.grossRevenue ?? 0n) - (prev.values?.grossRevenue ?? 0n);
    expect(rev?.delta?.dir).toBe(
      diff > 0n ? "up" : diff < 0n ? "down" : "flat",
    );
    expect(rev?.delta?.text).toMatch(/^(Up|Down) \d[\d,]*\.\d%$|^No change$/);
    expect(rev?.delta?.against).toBe("vs Q1");
    const opex = tiles.find((t) => t.key === "operatingExpenses");
    if (opex?.delta && opex.delta.dir !== "flat") {
      expect(opex.delta.tone).toBe(opex.delta.dir === "down" ? "good" : "bad");
    }
    const paid = tiles.find((t) => t.key === "paidInCapital");
    if (paid?.delta && paid.delta.dir !== "flat") {
      expect(paid.delta.text).toMatch(/^(Up|Down) \$/);
      expect(paid.delta.tone).toBe("neutral");
    }
    expect(tiles.find((t) => t.key === "dpiBps")?.value).toMatch(/x$/);
  });

  it("a partial period is not compared and says so", () => {
    const first = quarters[0];
    if (!first) throw new Error("no first quarter");
    expect(first.partial).toBe(true);
    const tiles = tileViews(
      FUND_TILES,
      quarters[1] as never,
      first,
      "Q4 2026",
      quarters,
    );
    const rev = tiles.find((t) => t.key === "grossRevenue");
    expect(rev?.delta).toBeNull();
    expect(rev?.deltaNote).toBe("Not compared: Q4 2026 is not complete");
  });

  it("no comparison chosen: no delta and no note", () => {
    const tiles = tileViews(FUND_TILES, cur, null, null, quarters);
    expect(tiles.every((t) => t.delta === null && t.deltaNote === null)).toBe(
      true,
    );
  });

  it("sparklines skip partial periods for flows", () => {
    const tiles = tileViews(FUND_TILES, cur, prev, "Q1", quarters);
    const whole = quarters.filter((p) => !p.partial && p.values).length;
    expect(tiles.find((t) => t.key === "grossRevenue")?.spark).toHaveLength(
      whole,
    );
    expect(tiles.find((t) => t.key === "paidInCapital")?.spark).toHaveLength(
      quarters.filter((p) => p.values).length,
    );
  });

  it("holder tiles and units", () => {
    const mine = aggregateHolder(
      holderSlice(holderMonths, "A"),
      fundMonths,
      "quarter",
      range,
    );
    const p = mine[mine.length - 2];
    if (!p?.values) throw new Error("no holder period");
    const tiles = tileViews(
      HOLDER_TILES,
      p,
      mine[mine.length - 3] ?? null,
      "Q",
      mine,
    );
    expect(tiles.map((t) => t.key)).toContain("dpiBps");
    expect(unitsTile(p.values).sub).toContain("% of the class");
    const m = aggregateHolder(
      holderSlice(holderMonths, "M"),
      fundMonths,
      "quarter",
      range,
    );
    const last = m[m.length - 1]?.values;
    if (last) expect(unitsTile(last).sub).toContain("Common units");
  });
});

describe("F3 cash flow", () => {
  it("steps add up to the change in Available Cash from the previous period end", () => {
    for (const [i, p] of quarters.entries()) {
      if (!p.values) continue;
      const opening =
        i === 0 ? 0n : (quarters[i - 1]?.values?.availableCash ?? 0n);
      const steps = cashFlowSteps(p.values, opening);
      const last = steps[steps.length - 1];
      expect(last?.label).toBe(CASH_FLOW_CHANGE_LABEL);
      expect(last?.to).toBe(p.values.availableCash - opening);
      const moves = steps.slice(0, -1).reduce((a, s) => a + s.amount, 0n);
      expect(moves).toBe(p.values.availableCash - opening);
    }
  });

  it("the comparison helper and the quarters see the same previous period", () => {
    const p = quarters[3];
    if (!p) throw new Error("short");
    const c = fundComparison(fundMonths as FundMonth[], p, "previous");
    expect(c?.key).toBe(quarters[2]?.key);
  });
});

describe("import rule (P14 acceptance)", () => {
  const roots = ["src/components/charts", "src/components/financials"];
  const forbidden = [
    /portal-router/,
    /\(authenticated\)/,
    /from "@\/server/,
    /from "(\.\.\/)+server\//,
    /financial-series-build/,
  ];
  it("no chart or dashboard component imports server code, portal procedures or team pages", () => {
    for (const root of roots) {
      for (const f of readdirSync(root)) {
        if (!/\.tsx?$/.test(f) || f.endsWith(".test.ts")) continue;
        const src = readFileSync(join(root, f), "utf8");
        const imports = src.match(/^import[^;]+;/gms) ?? [];
        for (const imp of imports) {
          for (const re of forbidden)
            expect(imp, `${f}: ${imp}`).not.toMatch(re);
        }
      }
    }
  });
});
