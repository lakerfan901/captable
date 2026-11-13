import "server-only";
import type { PeriodReportInput } from "@/lib/governance/report-figures";
import type { TPrismaOrTransaction } from "@/server/db";
import { getPeriodEconomics } from "@/server/llc/economics";

// The adapter from ECONOMICS' §8.2 period data to the report prefill
// (03-governance.md G12). The ONLY file that knows the ECONOMICS shape:
// every bigint cents value becomes a JS number here (FOUNDATION B1), and
// strings are cut to the bounds of `ReportFiguresSchema`.

function cents(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error("Cents value out of the safe integer range");
  }
  return n;
}

export async function loadPeriodReportInput(
  tx: TPrismaOrTransaction,
  companyId: string,
  period: { start: string; end: string },
): Promise<PeriodReportInput> {
  const e = await getPeriodEconomics(tx, companyId, {
    periodStart: period.start,
    periodEnd: period.end,
  });
  const items = e.distributions.items;
  const sum = (f: (i: (typeof items)[number]) => bigint) =>
    items.reduce((acc, i) => acc + f(i), 0n);
  const mp = e.managerAndAffiliatePayments;
  return {
    revenue: {
      grossRevenueCents: cents(e.revenue.grossRevenue),
      averageUtilizationBps: e.revenue.averageUtilizationBps,
    },
    expenses: {
      totalCents: cents(e.expenses.total),
      byCategory: e.expenses.byCategory.map((c) => ({
        category: c.category.slice(0, 200),
        amountCents: cents(c.amount),
      })),
    },
    managementFee: {
      accruedCents: cents(e.managementFee.accrued),
      paidCents: cents(e.managementFee.paid),
      unpaidAtEndCents: cents(e.managementFee.unpaidAtEnd),
    },
    reserves: {
      balanceAtEndCents: cents(e.reserves.balanceAtEnd),
      minimumRequiredCents: cents(e.reserves.minimumRequired),
    },
    distributions: {
      totalGrossCents: cents(e.distributions.totalGross),
      tierCCents: cents(sum((i) => i.tierC)),
      tierDCents: cents(sum((i) => i.tierD)),
      tierECents: cents(sum((i) => i.tierEPreferred + i.tierECommon)),
    },
    managerAndAffiliatePayments: {
      payments: mp.payments.map((p) => ({
        paidOn: p.paidOn,
        payee: p.payee.slice(0, 200),
        category: p.category.slice(0, 200),
        flow: p.flow,
        amountCents: cents(p.amount),
        memo: p.memo === null ? null : p.memo.slice(0, 2000),
        resolutionId: p.resolutionId,
      })),
      insiderDistributions: mp.insiderDistributions.map((d) => ({
        name: d.name.slice(0, 200),
        paymentDate: d.paymentDate,
        netCents: cents(d.net),
      })),
      insiderLoanPayments: mp.insiderLoanPayments.map((l) => ({
        name: l.name.slice(0, 200),
        paidOn: l.paidOn,
        principalCents: cents(l.principal),
        interestCents: cents(l.interest),
      })),
      grandTotalCents: cents(mp.grandTotal),
    },
  };
}
