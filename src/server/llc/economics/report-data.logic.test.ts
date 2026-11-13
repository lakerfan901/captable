import { describe, expect, it } from "vitest";
import type { CashLedger } from "../../../lib/llc/available-cash";
import { managementFeeForMonth } from "../../../lib/llc/management-fee";
import {
  buildPeriodEconomics,
  type PeriodEconomicsInput,
} from "./report-data.logic";

function month(m: string, receipts: bigint, fees: bigint, other = 0n) {
  return {
    month: m,
    customerReceipts: receipts,
    passThroughFees: fees,
    otherIncome: other,
    assetSaleProceeds: 0n,
    insuranceProceeds: 0n,
    managementFee: managementFeeForMonth(receipts - fees, 500),
  };
}

// AC-1: MF-1..3 in Apr–Jun 2027, other income $312.45 in June.
const ledger: CashLedger = {
  months: [
    month("2027-04-01", 4_825_000n, 723_750n),
    month("2027-05-01", 5_190_040n, 778_506n),
    month("2027-06-01", 3_987_525n, 598_129n, 31_245n),
  ],
  expenses: [
    {
      on: "2027-04-15",
      amount: 3_840_000n,
      fundingSource: "OPERATING_CASH",
      category: "COLOCATION",
      countsTowardOrgCap: false,
    },
    {
      on: "2027-05-03",
      amount: 3_100_000n,
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      category: "EQUIPMENT_ACQUISITION",
      countsTowardOrgCap: false,
    },
  ],
  reserves: [
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
  ],
  defaultIncome: [],
  loanPayments: [],
  loanProceeds: [],
  distributions: [],
  capitalReceived: [],
};

const payment = (
  id: string,
  paidOn: string,
  category: string,
  amountCents: bigint,
) => ({
  id,
  paidOn,
  payee: "Octagon Compute LLC",
  category,
  amountCents,
  countsTowardOrgCap: false,
  memo: null,
  resolutionId: null,
});

function input(over: Partial<PeriodEconomicsInput> = {}): PeriodEconomicsInput {
  return {
    period: { periodStart: "2027-04-01", periodEnd: "2027-06-30" },
    ledger,
    utilization: [
      { month: "2027-04-01", utilizationBps: 9000 },
      { month: "2027-05-01", utilizationBps: 8500 },
      { month: "2027-06-01", utilizationBps: null },
    ],
    managerPayments: [
      payment("p1", "2027-05-10", "MANAGEMENT_FEE", 205_063n),
      payment("p2", "2027-05-20", "EXPENSE_REIMBURSEMENT", 125_000n),
      payment("p3", "2027-06-01", "PURCHASING_AGENT_PASS_THROUGH", 30_000_000n),
    ],
    distributions: [
      {
        id: "dist1",
        number: 1,
        type: "OPERATING",
        paymentDate: "2027-06-15",
        gross: 15_309_760n,
        tierC: 0n,
        tierD: 0n,
        tierEPreferred: 0n,
        tierECommon: 15_309_760n,
        net: 15_309_760n,
        lines: [{ stakeholderId: "M", gross: 15_309_760n, net: 15_309_760n }],
      },
    ],
    loanPayments: [],
    holders: new Map([["M", { name: "Common Member", isInsider: true }]]),
    includeInsiderDistributions: true,
    minimumOperatingReserve: 5_000_000n,
    orgExpenseCap: 4_000_000n,
    memberLoansOutstandingAtEnd: 0n,
    ...over,
  };
}

describe("buildPeriodEconomics", () => {
  it("AC-1 period figures", () => {
    const r = buildPeriodEconomics(input());
    expect(r.revenue.grossRevenue).toBe(11_902_180n);
    expect(r.revenue.otherIncome).toBe(31_245n);
    expect(r.revenue.averageUtilizationBps).toBe(8750);
    expect(r.managementFee.accrued).toBe(595_110n);
    expect(r.managementFee.paid).toBe(205_063n);
    expect(r.managementFee.unpaidAtEnd).toBe(595_110n - 205_063n);
    expect(r.expenses.operating).toBe(3_840_000n);
    expect(r.expenses.fromCapital).toBe(3_100_000n);
    expect(r.expenses.total).toBe(6_940_000n);
    expect(r.reserves.balanceAtStart).toBe(5_000_000n);
    expect(r.reserves.established).toBe(1_500_000n);
    expect(r.reserves.balanceAtEnd).toBe(6_500_000n);
    expect(r.availableCashAtEnd.availableCash).toBe(5_998_315n);
  });

  it("R24: Manager and Affiliate payments with insider distributions", () => {
    const r = buildPeriodEconomics(input());
    const m = r.managerAndAffiliatePayments;
    expect(m.total).toBe(30_330_063n);
    expect(m.payments.map((p) => [p.id, p.flow])).toEqual([
      ["p1", "TO"],
      ["p2", "TO"],
      ["p3", "THROUGH"],
    ]);
    expect(m.insiderDistributions).toEqual([
      {
        stakeholderId: "M",
        name: "Common Member",
        distributionNumber: 1,
        paymentDate: "2027-06-15",
        gross: 15_309_760n,
        net: 15_309_760n,
      },
    ]);
    expect(m.grandTotal).toBe(45_639_823n);
    expect(r.distributions.totalGross).toBe(15_309_760n);
  });

  it("switch off: no insider distributions", () => {
    const m = buildPeriodEconomics(
      input({ includeInsiderDistributions: false }),
    ).managerAndAffiliatePayments;
    expect(m.insiderDistributions).toEqual([]);
    expect(m.grandTotal).toBe(30_330_063n);
  });

  it("rows outside the period are excluded", () => {
    const r = buildPeriodEconomics(
      input({ period: { periodStart: "2027-07-01", periodEnd: "2027-09-30" } }),
    );
    expect(r.revenue.grossRevenue).toBe(0n);
    expect(r.revenue.averageUtilizationBps).toBeNull();
    expect(r.managerAndAffiliatePayments.payments).toEqual([]);
    expect(r.distributions.items).toEqual([]);
    expect(r.reserves.balanceAtStart).toBe(6_500_000n);
  });
});
