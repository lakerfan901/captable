import { describe, expect, it } from "vitest";
import {
  type CashLedger,
  computeAvailableCash,
  computeUnusedCapital,
  loanAccruedInterest,
  orgExpenseCapStatus,
  reserveBalances,
} from "./available-cash";
import { managementFeeForMonth, type RevenueMonth } from "./management-fee";
import { LlcMathError } from "./money";

function month(
  m: string,
  receipts: bigint,
  fees: bigint,
  otherIncome = 0n,
): RevenueMonth {
  return {
    month: m,
    customerReceipts: receipts,
    passThroughFees: fees,
    otherIncome,
    assetSaleProceeds: 0n,
    insuranceProceeds: 0n,
    managementFee: managementFeeForMonth(receipts - fees, 500),
  };
}

const empty: CashLedger = {
  months: [],
  expenses: [],
  reserves: [],
  defaultIncome: [],
  loanPayments: [],
  loanProceeds: [],
  distributions: [],
  capitalReceived: [],
};

const AC1_RESERVES: CashLedger["reserves"] = [
  {
    on: "2027-02-01",
    kind: "MINIMUM_OPERATING",
    type: "ESTABLISH",
    amount: 5_000_000n,
    fundingSource: "CAPITAL_CONTRIBUTIONS",
    releaseTo: null,
  },
  {
    on: "2027-06-30",
    kind: "EQUIPMENT_REPAIR_AND_REPLACEMENT",
    type: "ESTABLISH",
    amount: 1_500_000n,
    fundingSource: "OPERATING_CASH",
    releaseTo: null,
  },
];

function ac1(operatingExpenses = 3_840_000n): CashLedger {
  return {
    ...empty,
    months: [
      month("2027-04-01", 4_825_000n, 723_750n),
      month("2027-05-01", 5_190_040n, 778_506n),
      month("2027-06-01", 3_987_525n, 598_129n, 31_245n),
    ],
    expenses: [
      {
        on: "2027-04-15",
        amount: operatingExpenses,
        fundingSource: "OPERATING_CASH",
        category: "COLOCATION",
        countsTowardOrgCap: false,
      },
      {
        on: "2027-04-15",
        amount: 3_100_000n,
        fundingSource: "CAPITAL_CONTRIBUTIONS",
        category: "ORGANIZATIONAL_OFFERING",
        countsTowardOrgCap: true,
      },
    ],
    reserves: AC1_RESERVES,
  };
}

describe("computeAvailableCash", () => {
  it("AC-1", () => {
    const r = computeAvailableCash(ac1(), "2027-06-30");
    expect(r.inflows.grossRevenue).toBe(11_902_180n);
    expect(r.inflows.otherIncome).toBe(31_245n);
    expect(r.outflows.operatingExpenses).toBe(3_840_000n);
    expect(r.outflows.managementFee).toBe(595_110n);
    expect(r.reservesFromOperatingCash).toBe(1_500_000n);
    expect(r.raw).toBe(5_998_315n);
    expect(r.availableCash).toBe(5_998_315n);
  });

  it("AC-2", () => {
    const base = ac1();
    const q3: RevenueMonth = {
      month: "2027-07-01",
      customerReceipts: 10_000_000n,
      passThroughFees: 0n,
      otherIncome: 0n,
      assetSaleProceeds: 0n,
      insuranceProceeds: 0n,
      managementFee: 500_000n,
    };
    const l: CashLedger = {
      ...base,
      months: [...base.months, q3],
      expenses: [
        ...base.expenses,
        {
          on: "2027-08-15",
          amount: 3_000_000n,
          fundingSource: "OPERATING_CASH",
          category: "POWER",
          countsTowardOrgCap: false,
        },
      ],
      reserves: [
        ...base.reserves,
        {
          on: "2027-09-30",
          kind: "EQUIPMENT_REPAIR_AND_REPLACEMENT",
          type: "RELEASE",
          amount: 500_000n,
          fundingSource: "OPERATING_CASH",
          releaseTo: null,
        },
      ],
      distributions: [
        { on: "2027-06-30", type: "OPERATING", gross: 5_998_315n },
      ],
    };
    const r = computeAvailableCash(l, "2027-09-30");
    expect(r.priorDistributions).toBe(5_998_315n);
    expect(r.availableCash).toBe(7_000_000n);
  });

  it("AC-3 negative raw floors at zero", () => {
    const r = computeAvailableCash(ac1(20_000_000n), "2027-06-30");
    expect(r.raw).toBe(-10_161_685n);
    expect(r.availableCash).toBe(0n);
  });

  it("AC-4 incomplete month excluded", () => {
    const r = computeAvailableCash(ac1(), "2027-05-31");
    expect(r.inflows.grossRevenue).toBe(8_512_784n);
    expect(r.inflows.otherIncome).toBe(0n);
    expect(r.outflows.managementFee).toBe(425_640n);
    expect(r.reservesFromOperatingCash).toBe(0n);
    expect(r.raw).toBe(4_247_144n);
    expect(r.availableCash).toBe(4_247_144n);
  });

  it("cross-pool release and operating loan service", () => {
    const l: CashLedger = {
      ...empty,
      reserves: [
        {
          on: "2027-01-01",
          kind: "WORKING_CAPITAL",
          type: "ESTABLISH",
          amount: 1_000n,
          fundingSource: "CAPITAL_CONTRIBUTIONS",
          releaseTo: null,
        },
        {
          on: "2027-02-01",
          kind: "WORKING_CAPITAL",
          type: "RELEASE",
          amount: 400n,
          fundingSource: "CAPITAL_CONTRIBUTIONS",
          releaseTo: "OPERATING_CASH",
        },
      ],
      loanPayments: [
        {
          on: "2027-02-01",
          principal: 100n,
          interest: 10n,
          fundingSource: "OPERATING_CASH",
        },
      ],
      defaultIncome: [{ on: "2027-02-01", amount: 50n }],
    };
    const r = computeAvailableCash(l, "2027-03-01");
    expect(r.inflows.crossToOperating).toBe(400n);
    expect(r.outflows.loanService).toBe(110n);
    expect(r.raw).toBe(340n);
  });
});

describe("reserveBalances", () => {
  it("RB-1", () => {
    const b = reserveBalances(AC1_RESERVES, "2027-06-30");
    expect(b.byKind.get("MINIMUM_OPERATING")).toEqual({
      operating: 0n,
      capital: 5_000_000n,
      total: 5_000_000n,
    });
    expect(b.total).toBe(6_500_000n);
    expect(b.operating).toBe(1_500_000n);
    expect(b.capital).toBe(5_000_000n);
  });

  it("RB-2 over-release throws", () => {
    const reserves: CashLedger["reserves"] = [
      ...AC1_RESERVES,
      {
        on: "2027-07-01",
        kind: "EQUIPMENT_REPAIR_AND_REPLACEMENT",
        type: "RELEASE",
        amount: 2_000_000n,
        fundingSource: "OPERATING_CASH",
        releaseTo: null,
      },
    ];
    expect(() => reserveBalances(reserves, "2027-07-31")).toThrow(LlcMathError);
    try {
      reserveBalances(reserves, "2027-07-31");
    } catch (e) {
      expect((e as LlcMathError).code).toBe("OVER_RELEASE");
    }
  });
});

describe("computeUnusedCapital", () => {
  it("UC-1", () => {
    const l: CashLedger = {
      ...empty,
      capitalReceived: [{ on: "2026-11-30", amount: 45_000_000n }],
      expenses: [
        {
          on: "2027-01-10",
          amount: 3_100_000n,
          fundingSource: "CAPITAL_CONTRIBUTIONS",
          category: "ORGANIZATIONAL_OFFERING",
          countsTowardOrgCap: true,
        },
        {
          on: "2027-01-20",
          amount: 30_000_000n,
          fundingSource: "CAPITAL_CONTRIBUTIONS",
          category: "EQUIPMENT_ACQUISITION",
          countsTowardOrgCap: false,
        },
      ],
      reserves: AC1_RESERVES.filter((r) => r.kind === "MINIMUM_OPERATING"),
    };
    const r = computeUnusedCapital(l, "2027-06-30");
    expect(r.spentFromCapital).toBe(33_100_000n);
    expect(r.reservesFromCapital).toBe(5_000_000n);
    expect(r.returned).toBe(0n);
    expect(r.unusedCapital).toBe(6_900_000n);
  });
});

describe("orgExpenseCapStatus", () => {
  it("OC-1", () => {
    const s = orgExpenseCapStatus({
      counted: 3_100_000n,
      cap: 4_000_000n,
      approvedIncrease: 0n,
      adding: 800_000n,
    });
    expect(s.remaining).toBe(900_000n);
    expect(s.wouldExceed).toBe(false);
  });

  it("OC-2", () => {
    const s = orgExpenseCapStatus({
      counted: 3_100_000n,
      cap: 4_000_000n,
      approvedIncrease: 0n,
      adding: 900_001n,
    });
    expect(s.wouldExceed).toBe(true);
  });

  it("OC-3", () => {
    const s = orgExpenseCapStatus({
      counted: 4_000_000n,
      cap: 4_000_000n,
      approvedIncrease: 1_000_000n,
      adding: 500_000n,
    });
    expect(s.limit).toBe(5_000_000n);
    expect(s.wouldExceed).toBe(false);
  });
});

describe("loanAccruedInterest", () => {
  it("simple actual/365, rounded once", () => {
    // $100,000 at 8% for 365 days = $8,000.00
    expect(
      loanAccruedInterest({
        principalOutstandingSegments: [
          { from: "2027-01-01", to: "2028-01-01", principal: 10_000_000n },
        ],
        bps: 800,
      }),
    ).toBe(800_000n);
    // two segments of 1 day each at $1,000: 2 × 1000 × 0.08 / 365 = 43.8356 cents → 44
    expect(
      loanAccruedInterest({
        principalOutstandingSegments: [
          { from: "2027-01-01", to: "2027-01-02", principal: 100_000n },
          { from: "2027-01-02", to: "2027-01-03", principal: 100_000n },
        ],
        bps: 800,
      }),
    ).toBe(44n);
  });
});
