/**
 * Period data for the §8.2 quarterly report and annual statement
 * (02-economics.md E19, R24). Pure, relative imports only. A row belongs to
 * the period when its date is in [periodStart, periodEnd]; a revenue month
 * when its first day is; a distribution by paymentDate.
 */
import {
  type AvailableCashResult,
  type CashLedger,
  computeAvailableCash,
  orgExpenseCapStatus,
  reserveBalances,
} from "../../../lib/llc/available-cash";
import { addDays, compareIso, type IsoDate } from "../../../lib/llc/dates";
import {
  grossRevenue,
  managementFeeSummary,
} from "../../../lib/llc/management-fee";
import type { Cents } from "../../../lib/llc/money";
import { orgCapCounted } from "./financials.logic";

export interface PeriodEconomics {
  period: { periodStart: IsoDate; periodEnd: IsoDate };
  revenue: {
    customerReceipts: Cents;
    passThroughFees: Cents;
    grossRevenue: Cents;
    otherIncome: Cents;
    assetSaleProceeds: Cents;
    insuranceProceeds: Cents;
    byMonth: {
      month: IsoDate;
      grossRevenue: Cents;
      utilizationBps: number | null;
    }[];
    averageUtilizationBps: number | null;
  };
  expenses: {
    total: Cents;
    operating: Cents;
    fromCapital: Cents;
    byCategory: { category: string; amount: Cents }[];
  };
  managementFee: { accrued: Cents; paid: Cents; unpaidAtEnd: Cents };
  reserves: {
    balanceAtStart: Cents;
    established: Cents;
    released: Cents;
    balanceAtEnd: Cents;
    byKind: { kind: string; balanceAtEnd: Cents }[];
    minimumRequired: Cents;
  };
  distributions: {
    items: {
      id: string;
      number: number;
      type: string;
      paymentDate: IsoDate;
      gross: Cents;
      tierC: Cents;
      tierD: Cents;
      tierEPreferred: Cents;
      tierECommon: Cents;
      net: Cents;
    }[];
    totalGross: Cents;
  };
  availableCashAtEnd: AvailableCashResult;
  managerAndAffiliatePayments: {
    payments: {
      id: string;
      paidOn: IsoDate;
      payee: string;
      category: string;
      flow: "TO" | "THROUGH";
      amount: Cents;
      memo: string | null;
      resolutionId: string | null;
    }[];
    total: Cents;
    insiderDistributions: {
      stakeholderId: string;
      name: string;
      distributionNumber: number;
      paymentDate: IsoDate;
      gross: Cents;
      net: Cents;
    }[];
    insiderLoanPayments: {
      stakeholderId: string;
      name: string;
      paidOn: IsoDate;
      principal: Cents;
      interest: Cents;
    }[];
    grandTotal: Cents;
  };
  orgExpenseCap: { counted: Cents; limit: Cents; remaining: Cents };
  memberLoansOutstandingAtEnd: Cents;
}

export interface PeriodManagerPaymentRow {
  id: string;
  paidOn: IsoDate;
  payee: string;
  category: string;
  amountCents: Cents;
  countsTowardOrgCap: boolean;
  memo: string | null;
  resolutionId: string | null;
}

export interface PeriodDistributionRow {
  id: string;
  number: number;
  type: string;
  paymentDate: IsoDate;
  gross: Cents;
  tierC: Cents;
  tierD: Cents;
  tierEPreferred: Cents;
  tierECommon: Cents;
  net: Cents;
  lines: { stakeholderId: string; gross: Cents; net: Cents }[];
}

export interface PeriodEconomicsInput {
  period: { periodStart: IsoDate; periodEnd: IsoDate };
  /** the company's whole cash ledger (`loadCashLedger`) */
  ledger: CashLedger;
  /** RevenuePeriod.utilizationBps by month (first day) */
  utilization: readonly { month: IsoDate; utilizationBps: number | null }[];
  /** every ManagerPayment of the company (reversal rows negative) */
  managerPayments: readonly PeriodManagerPaymentRow[];
  /** FINALIZED, unreversed, non-reversal distributions */
  distributions: readonly PeriodDistributionRow[];
  /** MemberLoanPayment rows (reversal rows negative) */
  loanPayments: readonly {
    lenderStakeholderId: string;
    paidOn: IsoDate;
    principal: Cents;
    interest: Cents;
  }[];
  holders: ReadonlyMap<string, { name: string; isInsider: boolean }>;
  includeInsiderDistributions: boolean;
  minimumOperatingReserve: Cents;
  orgExpenseCap: Cents;
  memberLoansOutstandingAtEnd: Cents;
}

export function buildPeriodEconomics(i: PeriodEconomicsInput): PeriodEconomics {
  const { periodStart, periodEnd } = i.period;
  const inPeriod = (d: IsoDate) =>
    compareIso(d, periodStart) >= 0 && compareIso(d, periodEnd) <= 0;
  const sum = <T>(rows: readonly T[], f: (r: T) => Cents): Cents =>
    rows.reduce((acc, r) => acc + f(r), 0n);

  // Revenue
  const months = i.ledger.months.filter((m) => inPeriod(m.month));
  const utilization = new Map(
    i.utilization.map((u) => [u.month, u.utilizationBps]),
  );
  const byMonth = months.map((m) => ({
    month: m.month,
    grossRevenue: grossRevenue(m),
    utilizationBps: utilization.get(m.month) ?? null,
  }));
  const utils = byMonth
    .map((m) => m.utilizationBps)
    .filter((u): u is number => u !== null);
  const averageUtilizationBps =
    utils.length === 0
      ? null
      : Math.round(utils.reduce((a, b) => a + b, 0) / utils.length);

  // Expenses
  const expenses = i.ledger.expenses.filter((e) => inPeriod(e.on));
  const byCategory = new Map<string, Cents>();
  for (const e of expenses) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0n) + e.amount);
  }

  // Management Fee (R22)
  const feePayments = i.managerPayments
    .filter((p) => p.category === "MANAGEMENT_FEE")
    .map((p) => ({ paidOn: p.paidOn, amount: p.amountCents }));
  const fee = managementFeeSummary(i.ledger.months, feePayments, {
    from: periodStart,
    to: periodEnd,
  });

  // Reserves (R21)
  const startBalances = reserveBalances(
    i.ledger.reserves,
    addDays(periodStart, -1),
  );
  const endBalances = reserveBalances(i.ledger.reserves, periodEnd);
  const reserveRows = i.ledger.reserves.filter((r) => inPeriod(r.on));

  // Distributions (by paymentDate)
  const distributions = i.distributions
    .filter((d) => inPeriod(d.paymentDate))
    .sort(
      (a, b) => compareIso(a.paymentDate, b.paymentDate) || a.number - b.number,
    );

  // R24
  const payments = i.managerPayments
    .filter((p) => inPeriod(p.paidOn))
    .sort((a, b) => compareIso(a.paidOn, b.paidOn))
    .map((p) => ({
      id: p.id,
      paidOn: p.paidOn,
      payee: p.payee,
      category: p.category,
      flow:
        p.category === "PURCHASING_AGENT_PASS_THROUGH"
          ? ("THROUGH" as const)
          : ("TO" as const),
      amount: p.amountCents,
      memo: p.memo,
      resolutionId: p.resolutionId,
    }));
  const total = sum(payments, (p) => p.amount);
  const nameOf = (id: string) => i.holders.get(id)?.name ?? id;
  const isInsider = (id: string) => i.holders.get(id)?.isInsider ?? false;
  const insiderDistributions = i.includeInsiderDistributions
    ? distributions.flatMap((d) =>
        d.lines
          .filter((l) => isInsider(l.stakeholderId))
          .map((l) => ({
            stakeholderId: l.stakeholderId,
            name: nameOf(l.stakeholderId),
            distributionNumber: d.number,
            paymentDate: d.paymentDate,
            gross: l.gross,
            net: l.net,
          })),
      )
    : [];
  const insiderLoanPayments = i.loanPayments
    .filter((p) => inPeriod(p.paidOn) && isInsider(p.lenderStakeholderId))
    .sort((a, b) => compareIso(a.paidOn, b.paidOn))
    .map((p) => ({
      stakeholderId: p.lenderStakeholderId,
      name: nameOf(p.lenderStakeholderId),
      paidOn: p.paidOn,
      principal: p.principal,
      interest: p.interest,
    }));

  // R23, as of the period end
  const cap = orgExpenseCapStatus({
    counted: orgCapCounted(
      i.ledger.expenses
        .filter((e) => compareIso(e.on, periodEnd) <= 0)
        .map((e) => ({
          countsTowardOrgCap: e.countsTowardOrgCap,
          amountCents: e.amount,
        })),
      i.managerPayments.filter((p) => compareIso(p.paidOn, periodEnd) <= 0),
    ),
    cap: i.orgExpenseCap,
    approvedIncrease: 0n,
  });

  return {
    period: { periodStart, periodEnd },
    revenue: {
      customerReceipts: sum(months, (m) => m.customerReceipts),
      passThroughFees: sum(months, (m) => m.passThroughFees),
      grossRevenue: sum(months, grossRevenue),
      otherIncome: sum(months, (m) => m.otherIncome),
      assetSaleProceeds: sum(months, (m) => m.assetSaleProceeds),
      insuranceProceeds: sum(months, (m) => m.insuranceProceeds),
      byMonth,
      averageUtilizationBps,
    },
    expenses: {
      total: sum(expenses, (e) => e.amount),
      operating: sum(
        expenses.filter((e) => e.fundingSource === "OPERATING_CASH"),
        (e) => e.amount,
      ),
      fromCapital: sum(
        expenses.filter((e) => e.fundingSource === "CAPITAL_CONTRIBUTIONS"),
        (e) => e.amount,
      ),
      byCategory: [...byCategory].map(([category, amount]) => ({
        category,
        amount,
      })),
    },
    managementFee: {
      accrued: fee.accruedInRange,
      paid: fee.paidInRange,
      unpaidAtEnd: fee.unpaid,
    },
    reserves: {
      balanceAtStart: startBalances.total,
      established: sum(
        reserveRows.filter((r) => r.type === "ESTABLISH"),
        (r) => r.amount,
      ),
      released: sum(
        reserveRows.filter((r) => r.type === "RELEASE"),
        (r) => r.amount,
      ),
      balanceAtEnd: endBalances.total,
      byKind: [...endBalances.byKind].map(([kind, b]) => ({
        kind,
        balanceAtEnd: b.total,
      })),
      minimumRequired: i.minimumOperatingReserve,
    },
    distributions: {
      items: distributions.map(({ lines: _lines, ...d }) => d),
      totalGross: sum(distributions, (d) => d.gross),
    },
    availableCashAtEnd: computeAvailableCash(i.ledger, periodEnd),
    managerAndAffiliatePayments: {
      payments,
      total,
      insiderDistributions,
      insiderLoanPayments,
      grandTotal:
        total +
        sum(insiderDistributions, (d) => d.net) +
        sum(insiderLoanPayments, (p) => p.principal + p.interest),
    },
    orgExpenseCap: {
      counted: cap.counted,
      limit: cap.limit,
      remaining: cap.remaining,
    },
    memberLoansOutstandingAtEnd: i.memberLoansOutstandingAtEnd,
  };
}
