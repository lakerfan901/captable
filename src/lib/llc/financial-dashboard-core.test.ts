import { describe, expect, it } from "vitest";
import {
  dashboardPeriods,
  driftOf,
  SELF_HOLDER_ID,
  selfHolderMonth,
  visibleRestatement,
} from "./financial-dashboard-core";
import { monthsBetween } from "./financial-periods";
import {
  type FundMonth,
  type HolderMonth,
  holderMonthToJson,
} from "./financial-series";
import { buildSeries } from "./financial-series-build";
import { generateWorld } from "./fixtures/series-world";

const world = generateWorld(11, { months: 14 });
const series = buildSeries(world.input, {
  from: world.inception,
  to: world.lastMonth,
});
const months = series.fundMonths.map((m) => m.month);

describe("selfHolderMonth", () => {
  it("replaces the internal holder id and keeps every figure", () => {
    const h = series.holderMonths[0] as HolderMonth;
    const json = holderMonthToJson(h);
    const out = selfHolderMonth(json);
    expect(out.holderId).toBe(SELF_HOLDER_ID);
    expect({ ...out, holderId: json.holderId }).toEqual(json);
    expect(Object.values(out)).not.toContain(h.holderId);
  });
});

describe("dashboardPeriods", () => {
  it("lists whole quarters and years through the last month, quarter before year", () => {
    const ms = monthsBetween("2026-01-01", "2026-12-01");
    expect(dashboardPeriods(ms, []).map((p) => p.key)).toEqual([
      "2026-Q1",
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
      "2026",
    ]);
  });
  it("leaves out a quarter and a year that have not ended with the months", () => {
    const ms = monthsBetween("2026-01-01", "2026-05-01");
    const out = dashboardPeriods(ms, []);
    expect(out.map((p) => p.key)).toEqual(["2026-Q1"]);
    expect(out[0]).toEqual({
      key: "2026-Q1",
      grain: "quarter",
      start: "2026-01-01",
      end: "2026-03-31",
      reportId: null,
    });
  });
  it("keeps the first period of a fund that starts mid-quarter with its calendar bounds", () => {
    const out = dashboardPeriods(monthsBetween("2026-11-01", "2027-03-01"), []);
    expect(out.map((p) => [p.key, p.start, p.end])).toEqual([
      ["2026-Q4", "2026-10-01", "2026-12-31"],
      ["2026", "2026-01-01", "2026-12-31"],
      ["2027-Q1", "2027-01-01", "2027-03-31"],
    ]);
  });
  it("links the first matching report of the right type, nothing else", () => {
    const ms = monthsBetween("2026-01-01", "2026-12-01");
    const out = dashboardPeriods(ms, [
      { publicId: "q2-newer", type: "QUARTERLY", periodEnd: "2026-06-30" },
      { publicId: "q2-older", type: "QUARTERLY", periodEnd: "2026-06-30" },
      { publicId: "notice", type: "NOTICE", periodEnd: "2026-03-31" },
      { publicId: "k1", type: "TAX_K1", periodEnd: "2026-12-31" },
      { publicId: "fy", type: "ANNUAL", periodEnd: "2026-12-31" },
      { publicId: "none", type: "QUARTERLY", periodEnd: null },
    ]);
    expect(Object.fromEntries(out.map((p) => [p.key, p.reportId]))).toEqual({
      "2026-Q1": null,
      "2026-Q2": "q2-newer",
      "2026-Q3": null,
      "2026-Q4": null,
      "2026": "fy",
    });
  });
  it("is empty without months; order of the input months does not matter", () => {
    expect(dashboardPeriods([], [])).toEqual([]);
    const ms = monthsBetween("2026-01-01", "2026-06-01");
    expect(dashboardPeriods([...ms].reverse(), [])).toEqual(
      dashboardPeriods(ms, []),
    );
  });
});

describe("driftOf", () => {
  const stored = { fund: series.fundMonths, holders: series.holderMonths };
  it("is empty when the snapshots equal the ledger", () => {
    expect(driftOf({ months, stored, ledger: stored })).toEqual([]);
  });
  it("names a changed fund field of the month that changed", () => {
    const m = months[3] as string;
    const ledger = {
      fund: series.fundMonths.map((f) =>
        f.month === m ? { ...f, grossRevenue: f.grossRevenue + 1n } : f,
      ),
      holders: series.holderMonths,
    };
    expect(driftOf({ months, stored, ledger })).toEqual([
      { month: m, fields: ["grossRevenue"], holders: [] },
    ]);
  });
  it("names a holder whose record changed even when the fund did not", () => {
    const h = series.holderMonths.find((x) => x.month === months[5]);
    if (!h) throw new Error("fixture: no holder month");
    const ledger = {
      fund: series.fundMonths,
      holders: series.holderMonths.map((x) =>
        x === h ? { ...x, netPaid: x.netPaid + 7n } : x,
      ),
    };
    expect(driftOf({ months, stored, ledger })).toEqual([
      {
        month: h.month,
        fields: [],
        holders: [{ holderId: h.holderId, fields: ["netPaid"] }],
      },
    ]);
  });
  it("counts a holder record that appeared or disappeared, and a missing fund row", () => {
    const m = months[2] as string;
    const extra: HolderMonth = {
      ...(series.holderMonths[0] as HolderMonth),
      holderId: "zz-new",
      month: m,
    };
    const gone = series.holderMonths.find((x) => x.month === m);
    if (!gone) throw new Error("fixture: no holder month");
    const ledger = {
      fund: series.fundMonths,
      holders: [...series.holderMonths.filter((x) => x !== gone), extra],
    };
    const out = driftOf({
      months,
      stored: {
        fund: series.fundMonths.filter((f) => f.month !== months[0]),
        holders: series.holderMonths,
      },
      ledger,
    });
    expect(out).toEqual([
      { month: months[0], fields: ["*"], holders: [] },
      {
        month: m,
        fields: [],
        holders: [
          { holderId: gone.holderId, fields: ["*"] },
          { holderId: "zz-new", fields: ["*"] },
        ].sort((a, b) => (a.holderId < b.holderId ? -1 : 1)),
      },
    ]);
  });
  it("refuses a month the ledger did not build", () => {
    expect(() =>
      driftOf({
        months: ["2040-01-01"],
        stored,
        ledger: { fund: [] as FundMonth[], holders: [] },
      }),
    ).toThrow(/No ledger record/);
  });
});

describe("visibleRestatement", () => {
  const t = (d: string) => new Date(`${d}T12:00:00Z`);
  const f = (version: number, dataHash: string, at: string) => ({
    version,
    dataHash,
    frozenAt: t(at),
  });
  it("is null for a month never restated", () => {
    expect(visibleRestatement([f(1, "a", "2026-04-01")], [])).toBeNull();
  });
  it("shows a restatement that changed the fund figures to every holder", () => {
    expect(
      visibleRestatement(
        [f(1, "a", "2026-04-01"), f(2, "b", "2026-06-01")],
        [],
      ),
    ).toEqual({ version: 2, at: t("2026-06-01") });
  });
  it("hides a restatement that changed only another holder's record", () => {
    expect(
      visibleRestatement(
        [f(1, "a", "2026-04-01"), f(2, "a", "2026-06-01")],
        [
          { version: 1, canonical: "{mine}" },
          { version: 2, canonical: "{mine}" },
        ],
      ),
    ).toBeNull();
  });
  it("shows a restatement of the holder's own record, an appearance and a disappearance", () => {
    const fund = [f(1, "a", "2026-04-01"), f(2, "a", "2026-06-01")];
    expect(
      visibleRestatement(fund, [
        { version: 1, canonical: "{old}" },
        { version: 2, canonical: "{new}" },
      ]),
    ).toEqual({ version: 2, at: t("2026-06-01") });
    expect(
      visibleRestatement(fund, [{ version: 2, canonical: "{new}" }]),
    ).toEqual({ version: 2, at: t("2026-06-01") });
    expect(
      visibleRestatement(fund, [{ version: 1, canonical: "{old}" }]),
    ).toEqual({ version: 2, at: t("2026-06-01") });
  });
  it("keeps an earlier visible restatement when a later one changed nothing for the holder", () => {
    expect(
      visibleRestatement(
        [
          f(1, "a", "2026-04-01"),
          f(2, "b", "2026-06-01"),
          f(3, "b", "2026-08-01"),
        ],
        [],
      ),
    ).toEqual({ version: 2, at: t("2026-06-01") });
  });
});
