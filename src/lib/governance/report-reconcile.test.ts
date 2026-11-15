import { describe, expect, it } from "vitest";
import {
  buildPeriodEconomics,
  type PeriodEconomicsInput,
} from "../../server/llc/economics/report-data.logic";
import type { CashLedger } from "../llc/available-cash";
import { managementFeeForMonth } from "../llc/management-fee";
import { figuresFromPeriodData, type ReportFigures } from "./report-figures";
import {
  periodReportInputFromEconomics,
  reconcileFigures,
} from "./report-reconcile";

function month(m: string, receipts: bigint, fees: bigint) {
  return {
    month: m,
    customerReceipts: receipts,
    passThroughFees: fees,
    otherIncome: 0n,
    assetSaleProceeds: 0n,
    insuranceProceeds: 0n,
    managementFee: managementFeeForMonth(receipts - fees, 500),
  };
}

const ledger: CashLedger = {
  months: [
    month("2027-04-01", 4_825_000n, 723_750n),
    month("2027-05-01", 5_190_040n, 778_506n),
    month("2027-06-01", 3_987_525n, 598_129n),
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
  reserves: [],
  defaultIncome: [],
  loanPayments: [],
  loanProceeds: [],
  distributions: [],
  capitalReceived: [],
};

const input: PeriodEconomicsInput = {
  period: { periodStart: "2027-04-01", periodEnd: "2027-06-30" },
  ledger,
  utilization: [{ month: "2027-04-01", utilizationBps: 9000 }],
  managerPayments: [
    {
      id: "p1",
      paidOn: "2027-05-10",
      payee: "Manager LLC",
      category: "MANAGEMENT_FEE",
      amountCents: 205_063n,
      countsTowardOrgCap: false,
      memo: null,
      resolutionId: null,
    },
  ],
  distributions: [
    {
      id: "d1",
      number: 1,
      type: "OPERATING",
      paymentDate: "2027-06-15",
      gross: 1_000_000n,
      tierC: 600_000n,
      tierD: 0n,
      tierEPreferred: 280_000n,
      tierECommon: 120_000n,
      net: 1_000_000n,
      lines: [
        { stakeholderId: "A", gross: 880_000n, net: 880_000n },
        { stakeholderId: "M", gross: 120_000n, net: 120_000n },
      ],
    },
  ],
  loanPayments: [],
  holders: new Map([
    ["A", { name: "Holder A", isInsider: false }],
    ["M", { name: "Common Member", isInsider: true }],
  ]),
  includeInsiderDistributions: true,
  minimumOperatingReserve: 5_000_000n,
  orgExpenseCap: 4_000_000n,
  memberLoansOutstandingAtEnd: 0n,
};

const pe = buildPeriodEconomics(input);
const fresh = (): ReportFigures =>
  figuresFromPeriodData(
    periodReportInputFromEconomics(pe),
    { start: "2027-04-01", end: "2027-06-30" },
    "2027-07-02T10:00:00.000Z",
  );

describe("reconcileFigures (P38)", () => {
  it("prefilled figures match the ledger", () => {
    expect(reconcileFigures(fresh(), pe)).toEqual([]);
  });

  it("reports a one-cent difference with the field named", () => {
    const f = fresh();
    f.revenue.amountCents = (f.revenue.amountCents ?? 0) + 1;
    expect(reconcileFigures(f, pe)).toEqual([
      {
        field: "revenue.amountCents",
        reportCents: Number(pe.revenue.grossRevenue) + 1,
        ledgerCents: Number(pe.revenue.grossRevenue),
      },
    ]);
  });

  it("ignores notes, the fetch time, confirmedNone and a typed utilization", () => {
    const f = fresh();
    f.revenue.note = "typed";
    f.expenses.note = "typed";
    f.distributions.note = "typed";
    f.source = {
      fetchedAt: "later",
      periodStart: "2027-04-01",
      periodEnd: "2027-06-30",
    };
    f.managerPayments.confirmedNone = true;
    f.utilization = { bps: 1234, note: "typed" };
    expect(reconcileFigures(f, pe)).toEqual([]);
  });

  it("compares expense lines by category, not by position", () => {
    const f = fresh();
    f.expenses.lines.reverse();
    expect(reconcileFigures(f, pe)).toEqual([]);
    f.expenses.lines = f.expenses.lines.filter(
      (l) => l.category !== "COLOCATION",
    );
    expect(reconcileFigures(f, pe)).toEqual([
      {
        field: "expenses.lines[COLOCATION]",
        reportCents: null,
        ledgerCents: 3_840_000,
      },
    ]);
  });

  it("names a hand-edited distribution tier, a missing figure and a changed Manager payment", () => {
    const f = fresh();
    f.distributions.residualCents = 1;
    f.reserves.balanceCents = null;
    const line = f.managerPayments.lines[0];
    if (!line) throw new Error("no line");
    line.amountCents += 100;
    const fields = reconcileFigures(f, pe).map((d) => d.field);
    expect(fields).toEqual([
      "reserves.balanceCents",
      "distributions.residualCents",
      "managerPayments.lines[2027-05-10 | Manager LLC | MANAGEMENT_FEE | TO |  | ]",
    ]);
  });

  it("includes the insider distribution of the Common Member", () => {
    const f = fresh();
    expect(f.managerPayments.insiderDistributions).toHaveLength(1);
    f.managerPayments.insiderDistributions = [];
    expect(reconcileFigures(f, pe).map((d) => d.field)).toEqual([
      "managerPayments.insiderDistributions[2027-06-15 | Common Member]",
    ]);
  });
});
