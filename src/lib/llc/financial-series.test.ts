import { describe, expect, it } from "vitest";
import { monthEnd } from "./financial-periods";
import {
  aggregate,
  aggregateHolder,
  canonicalJson,
  compareFundMonths,
  compareHolderMonths,
  comparePeriodValues,
  dpiBps,
  FUND_METRICS,
  type FundMonth,
  formatDpi,
  fundComparison,
  fundMonthFromJson,
  fundMonthToJson,
  HOLDER_METRICS,
  type HolderMonth,
  holderMonthFromJson,
  holderMonthToJson,
  holderSlice,
  meanBps,
} from "./financial-series";

function fm(month: string, over: Partial<FundMonth> = {}): FundMonth {
  return {
    schemaVersion: 1,
    month,
    asOf: monthEnd(month),
    inProgress: false,
    grossRevenue: 1_000_00n,
    otherIncome: 0n,
    assetSaleProceeds: 0n,
    insuranceProceeds: 0n,
    totalExpenses: 300_00n,
    operatingExpenses: 300_00n,
    capitalFundedExpenses: 0n,
    expensesByCategory: [{ category: "POWER", amount: 300_00n }],
    managementFeeAccrued: 50_00n,
    managementFeePaid: 0n,
    managementFeeUnpaid: 50_00n,
    netOperatingIncome: 650_00n,
    reserveBalance: 0n,
    reservesByKind: [],
    minimumReserve: 5_000_000n,
    reservesEstablished: 0n,
    reservesReleased: 0n,
    availableCash: 0n,
    distributions: {
      preferredReturn: 0n,
      returnOfCapital: 0n,
      residualPreferred: 0n,
      residualCommon: 0n,
      gross: 0n,
    },
    capitalReceived: 0n,
    paidInCapital: 10_000_000n,
    unreturnedCapital: 10_000_000n,
    preferredReturnAccruedToDate: 0n,
    preferredReturnPaidToDate: 0n,
    preferredReturnUnpaid: 0n,
    committed: 10_000_000n,
    uncalled: 0n,
    utilizationBps: null,
    memberLoansOutstanding: 0n,
    orgExpenseCap: { counted: 0n, limit: 4_000_000n },
    ...over,
  };
}

function hm(month: string, over: Partial<HolderMonth> = {}): HolderMonth {
  return {
    schemaVersion: 1,
    holderId: "A",
    month,
    asOf: monthEnd(month),
    inProgress: false,
    contributions: 0n,
    credits: 0n,
    forfeited: 0n,
    preferredReturnAccrued: 0n,
    preferredReturnPaid: 0n,
    capitalReturned: 0n,
    residualPaid: 0n,
    grossDistributions: 0n,
    defaultOffsets: 0n,
    taxAdvanceOffsets: 0n,
    netPaid: 0n,
    paidIn: 100_000_00n,
    unreturnedCapital: 100_000_00n,
    preferredUnits: 100_000_000n,
    commonUnits: 0n,
    preferredPct: "25.0000",
    preferredReturnUnpaid: 0n,
    committed: 100_000_00n,
    uncalled: 0n,
    calledOutstanding: 0n,
    ...over,
  };
}

const dist = (gross: bigint, residualCommon = 0n) => ({
  preferredReturn: gross - residualCommon,
  returnOfCapital: 0n,
  residualPreferred: 0n,
  residualCommon,
  gross,
});

describe("DPI", () => {
  it("12,000.00 distributed on 100,000.00 paid in is 1200 bps, 0.12x; null on zero paid-in", () => {
    expect(dpiBps(12_000_00n, 100_000_00n)).toBe(1200n);
    expect(formatDpi(1200n)).toBe("0.12x");
    expect(dpiBps(12_000_00n, 0n)).toBeNull();
    expect(formatDpi(null)).toBe("—");
  });

  it("rounds half away from zero to the basis point and to the hundredth", () => {
    // 1/3 x = 3333.33 bps → 3333; 2/3 x = 6666.67 → 6667; exact half 0.5 bps → 1
    expect(dpiBps(1n, 3n)).toBe(3333n);
    expect(dpiBps(2n, 3n)).toBe(6667n);
    expect(dpiBps(1n, 20_000n)).toBe(1n);
    expect(formatDpi(1250n)).toBe("0.13x");
    expect(formatDpi(1249n)).toBe("0.12x");
    expect(formatDpi(12_500n)).toBe("1.25x");
    expect(formatDpi(0n)).toBe("0.00x");
  });

  it("fund DPI uses cumulative distributions to the Preferred class from inception", () => {
    const months = [
      fm("2027-01-01", { distributions: dist(5_000_00n) }),
      fm("2027-02-01"),
      fm("2027-03-01", { distributions: dist(7_000_00n, 1_000_00n) }),
      fm("2027-04-01", {
        distributions: dist(1_000_00n),
        paidInCapital: 100_000_00n,
      }),
    ];
    // "Latest month" alone still counts every earlier distribution.
    const [apr] = aggregate(months, "month", {
      from: "2027-04-01",
      to: "2027-04-01",
    });
    expect(apr?.values?.cumulativeDistributions).toBe(13_000_00n);
    expect(apr?.values?.cumulativeDistributionsToPreferred).toBe(12_000_00n);
    expect(apr?.values?.dpiBps).toBe(1200n);
    const [q1] = aggregate(months, "quarter", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    expect(q1?.values?.distributionsToPreferred).toBe(11_000_00n);
    expect(q1?.values?.cumulativeDistributions).toBe(12_000_00n);
  });

  it("holder DPI = cumulative gross distributions ÷ paid in", () => {
    const fundMonths = ["2027-01-01", "2027-02-01", "2027-03-01"].map((m) =>
      fm(m),
    );
    const holder = [
      hm("2027-01-01", { grossDistributions: 4_000_00n }),
      hm("2027-03-01", { grossDistributions: 8_000_00n }),
    ];
    const [p] = aggregateHolder(holder, fundMonths, "month", {
      from: "2027-03-01",
      to: "2027-03-01",
    });
    expect(p?.values?.cumulativeGrossDistributions).toBe(12_000_00n);
    expect(p?.values?.dpiBps).toBe(1200n);
  });
});

describe("utilization", () => {
  it("a month without a value is null; a quarter with one of three filled is that value", () => {
    const months = [
      fm("2027-01-01"),
      fm("2027-02-01", { utilizationBps: 8_123 }),
      fm("2027-03-01"),
    ];
    const ms = aggregate(months, "month", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    expect(ms.map((p) => p.values?.utilizationBps)).toEqual([
      null,
      8_123,
      null,
    ]);
    const [q] = aggregate(months, "quarter", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    expect(q?.values?.utilizationBps).toBe(8_123);
  });

  it("mean of the months with a value, half up (as averageUtilizationBps)", () => {
    expect(meanBps([9000, 8500, null])).toBe(8750);
    expect(meanBps([1, 2])).toBe(2); // 1.5 → 2
    expect(meanBps([1, 1, 2])).toBe(1); // 1.33 → 1
    expect(meanBps([null, null])).toBeNull();
    expect(meanBps([])).toBeNull();
  });
});

describe("aggregate", () => {
  const months = [
    fm("2027-01-01", { reserveBalance: 10n, availableCash: 1n }),
    fm("2027-02-01", {
      reserveBalance: 20n,
      availableCash: 2n,
      expensesByCategory: [
        { category: "COLOCATION", amount: 100_00n },
        { category: "POWER", amount: 200_00n },
      ],
    }),
    fm("2027-03-01", { reserveBalance: 30n, availableCash: 3n }),
  ];

  it("sums flows, keeps end values, merges categories by name", () => {
    const [q] = aggregate(months, "quarter", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    expect(q?.partial).toBe(false);
    expect(q?.values?.grossRevenue).toBe(3_000_00n);
    expect(q?.values?.reserveBalance).toBe(30n);
    expect(q?.values?.availableCash).toBe(3n);
    expect(q?.values?.expensesByCategory).toEqual([
      { category: "COLOCATION", amount: 100_00n },
      { category: "POWER", amount: 800_00n },
    ]);
  });

  it("every catalogue metric follows its rule", () => {
    const [q] = aggregate(months, "quarter", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    if (!q?.values) throw new Error("no values");
    const monthPeriods = aggregate(months, "month", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    for (const def of FUND_METRICS) {
      const per = monthPeriods.map((p) =>
        p.values ? def.get(p.values) : null,
      );
      if (def.rule === "sum") {
        expect(def.get(q.values), def.key).toBe(
          per.reduce<bigint>((a, v) => a + BigInt(v ?? 0), 0n),
        );
      } else if (def.rule === "end") {
        expect(def.get(q.values), def.key).toBe(per.at(-1));
      }
    }
  });

  it("a period with no data is a gap, not a zero; a missing month makes it partial", () => {
    const ps = aggregate(
      months,
      "quarter",
      {
        from: "2026-10-01",
        to: "2027-06-01",
      },
      { inceptionMonth: "2026-10-01" },
    );
    expect(ps.map((p) => [p.key, p.hasData, p.partial])).toEqual([
      ["2026-Q4", false, true],
      ["2027-Q1", true, false],
      ["2027-Q2", false, true],
    ]);
    expect(ps[0]?.values).toBeNull();
    const [y] = aggregate(months, "year", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    expect(y?.partial).toBe(true);
    expect(y?.values?.grossRevenue).toBe(3_000_00n);
  });

  it("the month in progress makes its period partial and it is not compared", () => {
    const live = [
      ...months,
      fm("2027-04-01"),
      fm("2027-05-01"),
      fm("2027-06-01", { inProgress: true, asOf: "2027-06-14" }),
    ];
    const [q2] = aggregate(live, "quarter", {
      from: "2027-04-01",
      to: "2027-06-01",
    });
    expect(q2?.inProgress).toBe(true);
    expect(q2?.partial).toBe(true);
    const prev = fundComparison(
      live,
      q2 ?? { grain: "quarter", start: "" },
      "previous",
    );
    expect(prev?.key).toBe("2027-Q1");
    const changes = comparePeriodValues(FUND_METRICS, q2 ?? null, prev);
    expect(changes.grossRevenue?.status).toBe("PARTIAL");
    expect(changes.grossRevenue?.amount).toBeNull();
  });

  it("compares with the previous period and a year earlier", () => {
    const series = [
      fm("2026-01-01", { grossRevenue: 500_00n }),
      ...months,
      fm("2027-04-01", { grossRevenue: 1_500_00n }),
    ];
    const [apr] = aggregate(series, "month", {
      from: "2027-04-01",
      to: "2027-04-01",
    });
    if (!apr) throw new Error("no period");
    const c = comparePeriodValues(
      FUND_METRICS,
      apr,
      fundComparison(series, apr, "previous"),
    );
    expect(c.grossRevenue).toMatchObject({
      amount: 500_00n,
      pctBps: 5_000n,
      status: "OK",
    });
    expect(c.reservesEstablished?.status).toBe("PREVIOUS_ZERO");
    expect(fundComparison(series, apr, "yearAgo")).toBeNull(); // April 2026 has no data
    const [jan] = aggregate(series, "month", {
      from: "2027-01-01",
      to: "2027-01-01",
    });
    if (!jan) throw new Error("no period");
    const ya = comparePeriodValues(
      FUND_METRICS,
      jan,
      fundComparison(series, jan, "yearAgo"),
    );
    expect(ya.grossRevenue).toMatchObject({ amount: 500_00n, pctBps: 10_000n });
  });

  it("refuses two records of one month", () => {
    expect(() =>
      aggregate([fm("2027-01-01"), fm("2027-01-01")], "month", {
        from: "2027-01-01",
        to: "2027-01-01",
      }),
    ).toThrow(/Two fund records/);
  });
});

describe("holder series", () => {
  const fundMonths = ["2027-01-01", "2027-02-01", "2027-03-01"].map((m) =>
    fm(m),
  );

  it("a holder admitted in the second month: zeros before, end values from the last month", () => {
    const rows = [
      hm("2027-02-01", { contributions: 100_000_00n }),
      hm("2027-03-01", { preferredReturnAccrued: 657_53n }),
    ];
    const [q] = aggregateHolder(rows, fundMonths, "quarter", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    expect(q?.partial).toBe(false);
    expect(q?.values?.contributions).toBe(100_000_00n);
    expect(q?.values?.preferredReturnAccrued).toBe(657_53n);
    expect(q?.values?.paidIn).toBe(100_000_00n);
    const [jan] = aggregateHolder(rows, fundMonths, "month", {
      from: "2027-01-01",
      to: "2027-01-01",
    });
    expect(jan?.hasData).toBe(true);
    expect(jan?.values?.paidIn).toBe(0n);
  });

  it("only months on the fund calendar (cutoff) count", () => {
    const rows = [
      hm("2027-03-01"),
      hm("2027-04-01", { grossDistributions: 9n }),
    ];
    const [p] = aggregateHolder(rows, fundMonths, "quarter", {
      from: "2027-04-01",
      to: "2027-06-01",
    });
    expect(p?.hasData).toBe(false);
    expect(p?.values).toBeNull();
  });

  it("refuses records of several holders; the slice keeps one holder", () => {
    const rows = [hm("2027-01-01"), hm("2027-01-01", { holderId: "B" })];
    expect(() =>
      aggregateHolder(rows, fundMonths, "month", {
        from: "2027-01-01",
        to: "2027-01-01",
      }),
    ).toThrow(/several holders/);
    expect(holderSlice(rows, "B").map((r) => r.holderId)).toEqual(["B"]);
  });

  it("holder catalogue rules", () => {
    const rows = [
      hm("2027-01-01", { netPaid: 1n, paidIn: 5n }),
      hm("2027-02-01", { netPaid: 2n, paidIn: 6n }),
      hm("2027-03-01", { netPaid: 3n, paidIn: 7n }),
    ];
    const [q] = aggregateHolder(rows, fundMonths, "quarter", {
      from: "2027-01-01",
      to: "2027-03-01",
    });
    if (!q?.values) throw new Error("no values");
    const byKey = new Map(HOLDER_METRICS.map((d) => [d.key, d]));
    expect(byKey.get("netPaid")?.get(q.values)).toBe(6n);
    expect(byKey.get("paidIn")?.get(q.values)).toBe(7n);
  });
});

describe("stored JSON", () => {
  it("round-trips a fund month: cents as numbers, schemaVersion 1", () => {
    const m = fm("2027-01-01", {
      reservesByKind: [{ kind: "WIND_DOWN", balance: 5n }],
      utilizationBps: 9000,
      distributions: dist(10n, 3n),
    });
    const json = fundMonthToJson(m);
    expect(json.grossRevenue).toBe(100_000);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(fundMonthFromJson(JSON.parse(JSON.stringify(json)))).toEqual(m);
    expect(() => fundMonthFromJson({ ...json, schemaVersion: 2 })).toThrow();
    expect(() => fundMonthFromJson({ ...json, extra: 1 })).toThrow();
    expect(() =>
      fundMonthToJson(fm("2027-01-01", { grossRevenue: 2n ** 60n })),
    ).toThrow(RangeError);
  });

  it("round-trips a holder month: units as 6-dp strings", () => {
    const h = hm("2027-01-01", {
      preferredUnits: 40_250_000n,
      commonUnits: 1n,
    });
    const json = holderMonthToJson(h);
    expect(json.preferredUnits).toBe("40.250000");
    expect(json.commonUnits).toBe("0.000001");
    expect(holderMonthFromJson(JSON.parse(JSON.stringify(json)))).toEqual(h);
  });

  it("canonical JSON does not depend on key order", () => {
    const json = fundMonthToJson(fm("2027-01-01"));
    const reversed = Object.fromEntries(Object.entries(json).reverse());
    expect(canonicalJson(reversed as typeof json)).toBe(canonicalJson(json));
  });
});

describe("drift", () => {
  it("names the fields that differ, by path", () => {
    const a = fm("2027-01-01");
    expect(compareFundMonths(a, fm("2027-01-01"))).toEqual([]);
    const b = fm("2027-01-01", {
      grossRevenue: a.grossRevenue + 1n,
      distributions: dist(1n),
      expensesByCategory: [
        { category: "POWER", amount: 300_00n },
        { category: "COLOCATION", amount: 1n },
      ],
      asOf: "2027-01-20",
      inProgress: true,
    });
    expect(compareFundMonths(a, b)).toEqual([
      "distributions.gross",
      "distributions.preferredReturn",
      "expensesByCategory.COLOCATION",
      "grossRevenue",
    ]);
    expect(() => compareFundMonths(a, fm("2027-02-01"))).toThrow();
    expect(
      compareHolderMonths(hm("2027-01-01"), hm("2027-01-01", { netPaid: 1n })),
    ).toEqual(["netPaid"]);
  });
});
