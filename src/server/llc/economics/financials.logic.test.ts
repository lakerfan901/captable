import { describe, expect, it } from "vitest";
import {
  computeAvailableCash,
  computeUnusedCapital,
  reserveBalances,
} from "../../../lib/llc/available-cash";
import {
  managementFeeForMonth,
  managementFeeSummary,
} from "../../../lib/llc/management-fee";
import {
  advancesOutstanding,
  type CashLedgerRows,
  lastCompleteMonthEnd,
  loanState,
  orgCapCounted,
  type RevenueRow,
  reserveLedgerError,
  revenueYearRows,
  toCashLedger,
  toReserveEntries,
  unpaidFeeThrough,
} from "./financials.logic";

function month(
  m: string,
  receipts: bigint,
  fees: bigint,
  otherIncome = 0n,
): RevenueRow {
  return {
    month: m,
    customerReceiptsCents: receipts,
    passThroughFeesCents: fees,
    otherIncomeCents: otherIncome,
    assetSaleProceedsCents: 0n,
    insuranceProceedsCents: 0n,
    managementFeeCents: managementFeeForMonth(receipts - fees, 500),
  };
}

// MF-1..3
const MONTHS: RevenueRow[] = [
  month("2027-04-01", 4_825_000n, 723_750n),
  month("2027-05-01", 5_190_040n, 778_506n),
  month("2027-06-01", 3_987_525n, 598_129n, 31_245n),
];

const EMPTY: CashLedgerRows = {
  revenue: [],
  expenses: [],
  reserves: [],
  defaultPayments: [],
  loanPayments: [],
  loans: [],
  distributions: [],
  cashCapital: [],
};

// AC-1
const AC1: CashLedgerRows = {
  ...EMPTY,
  revenue: MONTHS,
  expenses: [
    {
      incurredOn: "2027-04-15",
      amountCents: 3_840_000n,
      fundingSource: "OPERATING_CASH",
      category: "COLOCATION",
      countsTowardOrgCap: false,
    },
    {
      incurredOn: "2027-03-01",
      amountCents: 3_100_000n,
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      category: "ORGANIZATIONAL_OFFERING",
      countsTowardOrgCap: true,
    },
  ],
  reserves: [
    {
      effectiveOn: "2027-02-01",
      kind: "MINIMUM_OPERATING",
      type: "ESTABLISH",
      amountCents: 5_000_000n,
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      releaseTo: null,
    },
    {
      effectiveOn: "2027-06-30",
      kind: "EQUIPMENT_REPAIR_AND_REPLACEMENT",
      type: "ESTABLISH",
      amountCents: 1_500_000n,
      fundingSource: "OPERATING_CASH",
      releaseTo: null,
    },
  ],
  cashCapital: [{ on: "2027-01-15", amount: 45_000_000n }],
};

describe("toCashLedger", () => {
  it("AC-1 rows → Available Cash $59,983.15", () => {
    const r = computeAvailableCash(toCashLedger(AC1), "2027-06-30");
    expect(r.inflows.grossRevenue).toBe(11_902_180n);
    expect(r.inflows.otherIncome).toBe(31_245n);
    expect(r.outflows.operatingExpenses).toBe(3_840_000n);
    expect(r.outflows.managementFee).toBe(595_110n);
    expect(r.reservesFromOperatingCash).toBe(1_500_000n);
    expect(r.raw).toBe(5_998_315n);
    expect(r.availableCash).toBe(5_998_315n);
  });

  it("an expense of $500.00 and its reversal net to 0", () => {
    const expense = {
      incurredOn: "2027-04-10",
      amountCents: 50_000n,
      fundingSource: "OPERATING_CASH" as const,
      category: "POWER",
      countsTowardOrgCap: false,
    };
    const rows: CashLedgerRows = {
      ...EMPTY,
      expenses: [expense, { ...expense, amountCents: -50_000n }],
    };
    const r = computeAvailableCash(toCashLedger(rows), "2027-06-30");
    expect(r.outflows.operatingExpenses).toBe(0n);
    expect(r.raw).toBe(0n);
  });

  it("a reserve ESTABLISH $15,000 and its reversal row → balance 0", () => {
    const establish = {
      effectiveOn: "2027-06-30",
      kind: "EQUIPMENT_REPAIR_AND_REPLACEMENT",
      type: "ESTABLISH" as const,
      amountCents: 1_500_000n,
      fundingSource: "OPERATING_CASH" as const,
      releaseTo: null,
    };
    const rows = [
      establish,
      { ...establish, effectiveOn: "2027-07-02", amountCents: -1_500_000n },
    ];
    const entries = toReserveEntries(rows);
    expect(entries[1]).toMatchObject({ type: "RELEASE", amount: 1_500_000n });
    const b = reserveBalances(entries, "2027-07-02");
    expect(b.total).toBe(0n);
    expect(b.operating).toBe(0n);
    expect(reserveLedgerError(rows)).toBeNull();
  });

  it("maps distributions, loans, default income and capital", () => {
    const rows: CashLedgerRows = {
      ...EMPTY,
      distributions: [
        {
          type: "OPERATING",
          periodEnd: "2027-06-30",
          paymentDate: "2027-07-15",
          amountCents: 100n,
        },
        {
          type: "RETURN_OF_UNUSED_CAPITAL",
          periodEnd: "2027-06-30",
          paymentDate: "2027-07-15",
          amountCents: 200n,
        },
      ],
      defaultPayments: [
        { paidOn: "2027-05-01", toInterestCents: 30n, toCostsCents: 20n },
      ],
      loans: [{ madeOn: "2027-05-01", principalCents: 1_000n }],
      loanPayments: [
        {
          paidOn: "2027-06-01",
          principalCents: 100n,
          interestCents: 5n,
          fundingSource: "OPERATING_CASH",
        },
      ],
      cashCapital: [{ on: "2027-01-01", amount: 10_000n }],
    };
    const l = toCashLedger(rows);
    expect(l.distributions.map((d) => d.on)).toEqual([
      "2027-06-30",
      "2027-07-15",
    ]);
    expect(l.defaultIncome).toEqual([{ on: "2027-05-01", amount: 50n }]);
    const ac = computeAvailableCash(l, "2027-06-30");
    expect(ac.raw).toBe(50n - 105n - 100n);
    const uc = computeUnusedCapital(l, "2027-07-15");
    expect(uc.unusedCapital).toBe(10_000n + 1_000n - 200n);
  });
});

describe("Management Fee", () => {
  it("MF-6 through managementFeeSummary", () => {
    const months = toCashLedger({ ...EMPTY, revenue: MONTHS }).months;
    const payments = [{ paidOn: "2027-07-20", amount: 595_110n }];
    const q2 = managementFeeSummary(months, payments, {
      from: "2027-04-01",
      to: "2027-06-30",
    });
    expect(q2.accruedInRange).toBe(595_110n);
    expect(q2.paidInRange).toBe(0n);
    expect(q2.unpaid).toBe(595_110n);
    const toQ3 = managementFeeSummary(months, payments, {
      from: "2027-07-01",
      to: "2027-09-30",
    });
    expect(toQ3.paidToDate).toBe(595_110n);
    expect(toQ3.unpaid).toBe(0n);
  });

  it("unpaid fee counts complete months only and every payment", () => {
    expect(lastCompleteMonthEnd("2027-07-20")).toBe("2027-06-30");
    expect(lastCompleteMonthEnd("2027-06-30")).toBe("2027-06-30");
    expect(unpaidFeeThrough(MONTHS, [], "2027-06-15")).toBe(
      205_063n + 220_577n,
    );
    expect(unpaidFeeThrough(MONTHS, [], "2027-07-20")).toBe(595_110n);
    // a payment dated later still counts (never pay ahead of accrual)
    expect(
      unpaidFeeThrough(MONTHS, [{ amountCents: 595_110n }], "2027-07-20"),
    ).toBe(0n);
  });
});

describe("reserves", () => {
  it("rejects a ledger that releases more than a pool holds", () => {
    const err = reserveLedgerError([
      ...AC1.reserves,
      {
        effectiveOn: "2027-07-01",
        kind: "EQUIPMENT_REPAIR_AND_REPLACEMENT",
        type: "RELEASE",
        amountCents: 2_000_000n,
        fundingSource: "OPERATING_CASH",
        releaseTo: null,
      },
    ]);
    expect(err).toMatch(/exceeds its balance/);
  });
});

describe("org cap counter", () => {
  it("sums counted expenses and counted Manager payments, net of reversals", () => {
    expect(
      orgCapCounted(
        [
          { countsTowardOrgCap: true, amountCents: 3_900_000n },
          { countsTowardOrgCap: false, amountCents: 999n },
          { countsTowardOrgCap: true, amountCents: 50_000n },
          { countsTowardOrgCap: true, amountCents: -50_000n },
        ],
        [{ countsTowardOrgCap: true, amountCents: 10_000n }],
      ),
    ).toBe(3_910_000n);
  });
});

describe("loanState", () => {
  const loan = {
    madeOn: "2027-01-01",
    maturityOn: "2028-01-01",
    principalCents: 3_650_000n,
    interestBps: 1_000,
  };
  it("accrues simple interest on the outstanding principal", () => {
    const s = loanState(
      loan,
      [
        {
          paidOn: "2027-04-11",
          principalCents: 1_825_000n,
          interestCents: 100_000n,
        },
      ],
      "2027-07-20",
    );
    // 100 days × 36,500 × 10% / 365 = 1,000.00; 100 days × 18,250 × 10% / 365 = 500.00
    expect(s.principalOutstanding).toBe(1_825_000n);
    expect(s.accruedInterest).toBe(150_000n);
    expect(s.interestPaid).toBe(100_000n);
    expect(s.pastMaturity).toBe(false);
  });
  it("flags a loan past maturity with principal outstanding", () => {
    expect(loanState(loan, [], "2028-01-01").pastMaturity).toBe(true);
    expect(loanState(loan, [], "2026-12-31").principalOutstanding).toBe(0n);
  });
});

describe("advancesOutstanding", () => {
  it("nets advances and recoveries per member", () => {
    const m = advancesOutstanding(
      [
        { stakeholderId: "a", amountCents: 1_000n },
        { stakeholderId: "b", amountCents: 500n },
        { stakeholderId: "b", amountCents: -500n },
      ],
      [{ stakeholderId: "a", amountCents: 400n }],
    );
    expect(m.get("a")).toBe(600n);
    expect(m.get("b")).toBe(0n);
  });
});

describe("revenueYearRows", () => {
  it("returns 12 months with zeros for missing ones and locks closed months", () => {
    const rows = revenueYearRows(
      2027,
      [
        {
          ...month("2027-04-01", 4_825_000n, 723_750n),
          utilizationBps: 8_000,
          notes: null,
          managementFeeBps: 500,
        },
      ],
      "2027-04-30",
    );
    expect(rows).toHaveLength(12);
    expect(rows[3]).toMatchObject({
      month: "2027-04-01",
      saved: true,
      locked: true,
      grossRevenue: 4_101_250n,
      managementFeeCents: 205_063n,
    });
    expect(rows[4]).toMatchObject({
      month: "2027-05-01",
      saved: false,
      locked: false,
      grossRevenue: 0n,
    });
  });
});
