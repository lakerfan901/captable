import { describe, expect, it } from "vitest";
import {
  compareOptionLabel,
  DEFAULT_PERIOD_STATE,
  monthsUntil,
  type PeriodState,
  parsePeriodState,
  resolveView,
  serializePeriodState,
  withBack,
  withGrain,
  withPeriod,
  withTrendClick,
} from "./period-state";

const span = { inception: "2026-11-01", last: "2028-06-01" };
const q = (s: Partial<PeriodState> = {}) => ({ ...DEFAULT_PERIOD_STATE, ...s });
const parse = (qs: string) => {
  const p = new URLSearchParams(qs);
  return parsePeriodState((k) => p.get(k));
};

describe("query", () => {
  it("round-trips and omits defaults", () => {
    const s: PeriodState = {
      grain: "year",
      period: "2027",
      compare: "yearAgo",
      drill: ["2027", "2027-Q2"],
    };
    const qs = serializePeriodState(s, new URLSearchParams("tab=fund"));
    expect(qs.get("tab")).toBe("fund");
    expect(parse(qs.toString())).toEqual(s);
    expect(serializePeriodState(DEFAULT_PERIOD_STATE).toString()).toBe("");
  });
  it("falls back on malformed values", () => {
    expect(
      parse("grain=week&period=drop%20table&compare=x&drill=a,2027-Q9"),
    ).toEqual(DEFAULT_PERIOD_STATE);
  });
});

describe("resolveView", () => {
  it("selects the latest period by default, with a trend of 8 quarters", () => {
    const v = resolveView(q(), span);
    expect(v.periods[0]?.key).toBe("2026-Q4");
    expect(v.focus.key).toBe("2028-Q2");
    expect(v.trendGrain).toBe("quarter");
    expect(v.trendRange).toEqual({ from: "2026-11-01", to: "2028-06-01" });
    expect(v.highlightKey).toBe("2028-Q2");
    expect(v.drillable).toBe(true);
    expect(v.prevKey).toBe("2028-Q1");
    expect(v.nextKey).toBeNull();
    expect(v.comparison?.key).toBe("2028-Q1");
  });

  it("an unknown period falls back to the latest", () => {
    expect(resolveView(q({ period: "2031-Q1" }), span).focus.key).toBe(
      "2028-Q2",
    );
  });

  it("month grain: last 12 months, months are picked, not drilled", () => {
    const v = resolveView(q({ grain: "month", period: "2027-03" }), span);
    expect(v.trendRange).toEqual({ from: "2026-11-01", to: "2027-10-01" });
    expect(v.pickable).toBe(true);
    expect(v.drillable).toBe(false);
    const late = resolveView(q({ grain: "month" }), span);
    expect(late.trendRange).toEqual({ from: "2027-07-01", to: "2028-06-01" });
  });

  it("year grain drills into quarters, then months; Back pops one level", () => {
    let s = q({ grain: "year" });
    let v = resolveView(s, span);
    expect(v.focus.key).toBe("2028");
    s = withTrendClick(s, v, "2027");
    v = resolveView(s, span);
    expect(s.period).toBe("2027");
    expect(v.focus.key).toBe("2027");
    expect(v.trendGrain).toBe("quarter");
    expect(v.drillCaption).toBe("the quarters of FY2027");
    s = withTrendClick(s, v, "2027-Q2");
    v = resolveView(s, span);
    expect(v.drill).toEqual(["2027", "2027-Q2"]);
    expect(v.trendGrain).toBe("month");
    expect(v.trendRange).toEqual({ from: "2027-04-01", to: "2027-06-01" });
    expect(v.drillable).toBe(false);
    expect(v.showPicker).toBe(false);
    s = withBack(s, v);
    v = resolveView(s, span);
    expect(v.drill).toEqual(["2027"]);
    s = withBack(s, v);
    v = resolveView(s, span);
    expect(v.drill).toEqual([]);
    expect(v.focus.key).toBe("2027");
    expect(v.grain).toBe("year");
  });

  it("drill and Back keep the grain and the selected quarter", () => {
    let s = q({ period: "2027-Q3" });
    let v = resolveView(s, span);
    s = withTrendClick(s, v, "2027-Q2");
    v = resolveView(s, span);
    expect(v.focus.key).toBe("2027-Q2");
    expect(v.trendRange).toEqual({ from: "2027-04-01", to: "2027-06-01" });
    expect(v.showPicker).toBe(true);
    // stepping while drilled moves the drill with the selection
    s = withPeriod(s, v, "2027-Q3");
    v = resolveView(s, span);
    expect(v.drill).toEqual(["2027-Q3"]);
    s = withBack(s, v);
    v = resolveView(s, span);
    expect(v.focus.key).toBe("2027-Q3");
    expect(v.trendGrain).toBe("quarter");
  });

  it("since inception: one period, quarters in the trend, any quarter drills", () => {
    let s = withGrain(q({ period: "2027-Q2" }), "inception");
    let v = resolveView(s, span);
    expect(v.focus.key).toBe("inception");
    expect(v.focusRange).toEqual({ from: "2026-11-01", to: "2028-06-01" });
    expect(v.comparison).toBeNull();
    expect(v.showPicker).toBe(false);
    s = withTrendClick(s, v, "2027-Q1");
    v = resolveView(s, span);
    expect(v.drill).toEqual(["2027-Q1"]);
    expect(v.trendGrain).toBe("month");
  });

  it("an invalid drill from the URL is dropped", () => {
    expect(resolveView(q({ drill: ["2027-Q2"] }), span).drill).toEqual([]);
    expect(
      resolveView(q({ period: "2027-Q2", drill: ["2027-Q2", "2027-Q3"] }), span)
        .drill,
    ).toEqual(["2027-Q2"]);
    expect(
      resolveView(
        q({ grain: "year", period: "2027", drill: ["2027", "2028-Q1"] }),
        span,
      ).drill,
    ).toEqual(["2027"]);
  });

  it("the first quarter is clamped to inception", () => {
    const v = resolveView(q({ period: "2026-Q4" }), span);
    expect(v.focusRange).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    expect(v.prevKey).toBeNull();
  });

  it("comparison labels", () => {
    const v = resolveView(q({ period: "2027-Q3" }), span);
    expect(compareOptionLabel(v, "previous")).toBe(
      "Q2 2027 (previous quarter)",
    );
    expect(compareOptionLabel(v, "yearAgo")).toBe(
      "Q3 2026 (same quarter a year earlier)",
    );
    expect(compareOptionLabel(v, "none")).toBe("No comparison");
    const none = resolveView(q({ period: "2027-Q3", compare: "none" }), span);
    expect(none.comparison).toBeNull();
  });
});

describe("monthsUntil", () => {
  it("counts whole months, never negative", () => {
    expect(monthsUntil("2027-06-01", "2031-06-01")).toBe(48);
    expect(monthsUntil("2027-06-01", "2027-06-01")).toBe(0);
    expect(monthsUntil("2032-01-01", "2031-06-01")).toBe(0);
  });
});
