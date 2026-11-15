import { describe, expect, it } from "vitest";
import {
  changeOf,
  clampRange,
  comparisonPeriod,
  cutAtPublishedThrough,
  groupByGrain,
  isMonthKey,
  isMonthPublished,
  monthEnd,
  monthOf,
  monthsBetween,
  periodByKey,
  periodKey,
  periodLabel,
  publishedThrough,
} from "./financial-periods";

describe("months", () => {
  it("month keys, ends and ranges", () => {
    expect(isMonthKey("2027-02-01")).toBe(true);
    expect(isMonthKey("2027-02-02")).toBe(false);
    expect(monthOf("2027-02-17")).toBe("2027-02-01");
    expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    expect(monthEnd("2027-12-01")).toBe("2027-12-31");
    expect(monthsBetween("2026-11-01", "2027-02-01")).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
    ]);
    expect(monthsBetween("2027-02-01", "2027-01-01")).toEqual([]);
    expect(() => monthsBetween("2027-02-03", "2027-03-01")).toThrow(
      /month key/,
    );
  });

  it("period keys and labels", () => {
    expect(periodKey("2027-05-01", "month")).toBe("2027-05");
    expect(periodKey("2027-05-01", "quarter")).toBe("2027-Q2");
    expect(periodKey("2027-12-01", "quarter")).toBe("2027-Q4");
    expect(periodKey("2027-05-01", "year")).toBe("2027");
    expect(periodKey("2027-05-01", "inception")).toBe("inception");
    expect(periodLabel("2027-05")).toBe("May 2027");
    expect(periodLabel("2027-Q2")).toBe("Q2 2027");
    expect(periodLabel("2027")).toBe("FY2027");
    expect(periodLabel("inception")).toBe("Since inception");
    expect(() => periodLabel("2027-Q5")).toThrow(/period key/);
    const q = periodByKey("2027-Q1");
    expect(q.months).toEqual(["2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(q.end).toBe("2027-03-31");
  });
});

describe("groupByGrain", () => {
  it("whole calendar periods, with the part inside the range", () => {
    const qs = groupByGrain(
      { from: "2027-02-01", to: "2027-07-01" },
      "quarter",
      "2026-11-01",
    );
    expect(qs.map((q) => q.key)).toEqual(["2027-Q1", "2027-Q2", "2027-Q3"]);
    expect(qs[0]?.months).toHaveLength(3);
    expect(qs[0]?.rangeMonths).toEqual(["2027-02-01", "2027-03-01"]);
    expect(qs[1]?.rangeMonths).toHaveLength(3);
    expect(qs[2]?.rangeMonths).toEqual(["2027-07-01"]);
  });

  it("years and months", () => {
    expect(
      groupByGrain(
        { from: "2026-11-01", to: "2027-02-01" },
        "year",
        "2026-11-01",
      ).map((p) => [p.key, p.rangeMonths.length, p.months.length]),
    ).toEqual([
      ["2026", 2, 12],
      ["2027", 2, 12],
    ]);
    expect(
      groupByGrain(
        { from: "2027-01-01", to: "2027-03-01" },
        "month",
        "2026-11-01",
      ),
    ).toHaveLength(3);
  });

  it("since inception is one period from the inception month to the range end", () => {
    const [p, ...rest] = groupByGrain(
      { from: "2027-06-01", to: "2027-09-01" },
      "inception",
      "2026-11-01",
    );
    expect(rest).toHaveLength(0);
    expect(p?.start).toBe("2026-11-01");
    expect(p?.end).toBe("2027-09-30");
    expect(p?.months).toHaveLength(11);
    expect(
      groupByGrain(
        { from: "2026-01-01", to: "2026-03-01" },
        "inception",
        "2026-11-01",
      ),
    ).toEqual([]);
  });
});

describe("comparison", () => {
  it("previous period and the same period one year earlier", () => {
    const q = periodByKey("2027-Q1");
    expect(comparisonPeriod(q, "previous")?.key).toBe("2026-Q4");
    expect(comparisonPeriod(q, "yearAgo")?.key).toBe("2026-Q1");
    expect(comparisonPeriod(periodByKey("2027-01"), "previous")?.key).toBe(
      "2026-12",
    );
    expect(comparisonPeriod(periodByKey("2027"), "previous")?.key).toBe("2026");
    expect(
      comparisonPeriod({ grain: "inception", start: "2026-11-01" }, "previous"),
    ).toBeNull();
  });

  it("amount and percentage; zero, missing and partial are not a percentage", () => {
    const full = (v: bigint | null) => ({ value: v, partial: false });
    expect(changeOf(full(12_000n), full(10_000n))).toMatchObject({
      amount: 2_000n,
      pctBps: 2_000n,
      status: "OK",
    });
    // half away from zero: 1/3 of a percent… −1/3
    expect(changeOf(full(2n), full(3n)).pctBps).toBe(-3_333n);
    expect(changeOf(full(5n), full(-10n))).toMatchObject({
      amount: 15n,
      pctBps: 15_000n,
    });
    expect(changeOf(full(5n), full(0n))).toMatchObject({
      amount: 5n,
      pctBps: null,
      status: "PREVIOUS_ZERO",
    });
    expect(changeOf(full(5n), null).status).toBe("NOT_AVAILABLE");
    expect(changeOf(full(5n), full(null)).status).toBe("NOT_AVAILABLE");
    expect(changeOf({ value: 5n, partial: true }, full(4n))).toMatchObject({
      amount: null,
      pctBps: null,
      status: "PARTIAL",
    });
    expect(changeOf(full(5n), { value: 4n, partial: true }).status).toBe(
      "PARTIAL",
    );
  });
});

describe("published-through date (P33)", () => {
  it("latest quarterly or annual period end; notices and K-1 do not count", () => {
    expect(publishedThrough([])).toBeNull();
    expect(
      publishedThrough([
        { type: "QUARTERLY", periodEnd: "2027-03-31" },
        { type: "NOTICE", periodEnd: null },
        { type: "TAX_K1", periodEnd: "2027-12-31" },
        { type: "QUARTERLY", periodEnd: "2027-06-30" },
        { type: "NOTICE", periodEnd: "2027-09-30" },
      ]),
    ).toBe("2027-06-30");
    expect(
      publishedThrough([
        { type: "ANNUAL", periodEnd: "2027-12-31" },
        { type: "QUARTERLY", periodEnd: "2027-09-30" },
      ]),
    ).toBe("2027-12-31");
    expect(
      publishedThrough([{ type: "TAX_K1", periodEnd: "2027-12-31" }]),
    ).toBeNull();
  });

  it("whole months only; nothing after the date; nothing without one", () => {
    const rows = monthsBetween("2027-01-01", "2027-08-01").map((month) => ({
      month,
    }));
    expect(
      cutAtPublishedThrough(rows, "2027-06-30").map((r) => r.month),
    ).toEqual(monthsBetween("2027-01-01", "2027-06-01"));
    // a mid-month date publishes only the months that ended
    expect(cutAtPublishedThrough(rows, "2027-06-29").at(-1)?.month).toBe(
      "2027-05-01",
    );
    expect(cutAtPublishedThrough(rows, null)).toEqual([]);
    expect(isMonthPublished("2027-06-01", "2027-06-30")).toBe(true);
    expect(isMonthPublished("2027-07-01", "2027-06-30")).toBe(false);
  });

  it("clamps a range to the date", () => {
    expect(
      clampRange({ from: "2027-01-01", to: "2027-12-01" }, "2027-06-30"),
    ).toEqual({ from: "2027-01-01", to: "2027-06-01" });
    expect(
      clampRange({ from: "2027-01-01", to: "2027-03-01" }, "2027-06-30"),
    ).toEqual({ from: "2027-01-01", to: "2027-03-01" });
    expect(
      clampRange({ from: "2027-07-01", to: "2027-09-01" }, "2027-06-30"),
    ).toBeNull();
    expect(
      clampRange({ from: "2027-01-01", to: "2027-03-01" }, null),
    ).toBeNull();
    expect(
      clampRange({ from: "2027-01-01", to: "2027-12-01" }, "2027-06-15"),
    ).toEqual({ from: "2027-01-01", to: "2027-05-01" });
  });
});
