import { describe, expect, it } from "vitest";
import {
  formatChangeAmount,
  formatChangePct,
  formatChangePoints,
  formatMoney,
  formatMoneyCompact,
  formatPercentBps,
  formatTick,
  formatUnits,
  formatValue,
  niceScale,
  plotNumber,
} from "./chart-format";

describe("plotNumber (the one bigint → number conversion)", () => {
  it("keeps cents exact and null as null", () => {
    expect(plotNumber(123_456_789n)).toBe(123_456_789);
    expect(plotNumber(-5n)).toBe(-5);
    expect(plotNumber(0n)).toBe(0);
    expect(plotNumber(null)).toBeNull();
    expect(plotNumber(9160)).toBe(9160);
  });
  it("refuses values a number cannot hold exactly", () => {
    expect(() => plotNumber(2n ** 60n)).toThrow(RangeError);
    expect(() => plotNumber(1.5)).toThrow(RangeError);
  });
});

describe("full values", () => {
  it("formats money, percent, DPI and gaps", () => {
    expect(formatMoney(41_220_000n)).toBe("$412,200.00");
    expect(formatMoney(-4_000_000n)).toBe("-$40,000.00");
    expect(formatMoney(null)).toBe("—");
    expect(formatPercentBps(9160)).toBe("91.60%");
    expect(formatPercentBps(-250)).toBe("-2.50%");
    expect(formatPercentBps(5)).toBe("0.05%");
    expect(formatValue("dpiBps", 1200n)).toBe("0.12x");
    expect(formatValue("bps", null)).toBe("—");
    expect(formatValue("cents", 1n)).toBe("$0.01");
  });
  it("formats units with separators", () => {
    expect(formatUnits(1_050_000_000n)).toBe("1,050");
    expect(formatUnits(12_345_670n)).toBe("12.34567");
    expect(formatUnits(-1n)).toBe("-0.000001");
  });
});

describe("compact labels", () => {
  it.each([
    [0, "$0"],
    [95_000, "$950"],
    [100_000, "$1K"],
    [41_220_000, "$412.2K"],
    [123_456_789, "$1.23M"],
    [710_000_000, "$7.1M"],
    [-120_000_000, "-$1.2M"],
    [250_000_000_000, "$2.5B"],
  ])("%d cents → %s", (cents, text) => {
    expect(formatMoneyCompact(cents)).toBe(text);
  });
  it("ticks by unit", () => {
    expect(formatTick("bps", 5000)).toBe("50%");
    expect(formatTick("bps", 2500)).toBe("25%");
    expect(formatTick("dpiBps", 2500)).toBe("0.25x");
    expect(formatTick("cents", 50_000_000)).toBe("$500K");
  });
});

describe("changes", () => {
  it("percent with one decimal, half away from zero, unsigned", () => {
    expect(formatChangePct(1234n)).toBe("12.3%");
    expect(formatChangePct(-1235n)).toBe("12.4%");
    expect(formatChangePct(5n)).toBe("0.1%");
    expect(formatChangePct(1_000_000n)).toBe("10,000.0%");
  });
  it("points for percentages", () => {
    expect(formatChangePoints(70n)).toBe("0.7 pts");
    expect(formatChangePoints(-1_050n)).toBe("10.5 pts");
  });
  it("amount by unit and preference", () => {
    expect(formatChangeAmount("cents", -120_000n, -750n, true)).toBe("7.5%");
    expect(formatChangeAmount("cents", -120_000n, -750n, false)).toBe(
      "$1,200.00",
    );
    expect(formatChangeAmount("cents", 120_000n, null, true)).toBe("$1,200.00");
    expect(formatChangeAmount("dpiBps", -300n, null, false)).toBe("0.03x");
    expect(formatChangeAmount("bps", 70n, null, true)).toBe("0.7 pts");
  });
});

describe("niceScale", () => {
  it("starts at zero for positive values", () => {
    const s = niceScale([10, 412, null, 377]);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(412);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks).toEqual([0, 125, 250, 375, 500]);
  });
  it("includes negatives and zero", () => {
    const s = niceScale([-120, 380]);
    expect(s.min).toBeLessThanOrEqual(-120);
    expect(s.max).toBeGreaterThanOrEqual(380);
    expect(s.ticks).toContain(0);
    for (let i = 1; i < s.ticks.length; i++) {
      expect((s.ticks[i] as number) > (s.ticks[i - 1] as number)).toBe(true);
    }
  });
  it("all negative", () => {
    const s = niceScale([-50, -10]);
    expect(s.max).toBe(0);
    expect(s.min).toBeLessThanOrEqual(-50);
  });
  it("leaves headroom above a maximum on a tick", () => {
    expect(niceScale([100_000]).max).toBeGreaterThan(100_000);
  });
  it("no values: zero to the fallback", () => {
    expect(niceScale([null, null], 4, 10_000)).toEqual({
      min: 0,
      max: 10_000,
      ticks: [0, 2500, 5000, 7500, 10_000],
    });
    expect(niceScale([]).ticks[0]).toBe(0);
  });
});
