// Release check of a quarterly or annual report against the ledger
// (04-investor-portal.md P38, 5.9 step 4). Pure: relative imports only.
//
// A ledger-derived figure is any figure `figuresFromPeriodData` prefills from
// the period data. Not compared: every `note`, `source` (fetch time),
// `managerPayments.confirmedNone`, `distributions.none` when it agrees with
// the ledger (it is derived from the total, which is compared; a report
// marked "No distribution" while the ledger has one is a difference, field
// `distributions.none`) and `utilization.bps`: a refresh keeps a
// typed utilization (`figuresFromPeriodData` with `previous`), the ledger
// average may be missing while the quarterly checklist requires a value, and
// the dashboard labels utilization "as reported by the Manager". Comparing it
// would make some reports impossible to release.

import type { PeriodEconomics } from "../../server/llc/economics/report-data.logic";
import type { FundValues } from "../llc/financial-series";
import {
  figuresFromPeriodData,
  type PeriodReportInput,
  type ReportFigures,
} from "./report-figures";

function cents(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError("Cents value out of the safe integer range");
  }
  return n;
}

/**
 * ECONOMICS period data → the report prefill input. The same mapping as the
 * server adapter `loadPeriodReportInput` (member-report-router
 * `period-data.ts`), as a pure function so the release check and the tests
 * use it without the database.
 */
export function periodReportInputFromEconomics(
  e: PeriodEconomics,
): PeriodReportInput {
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

/**
 * The numeric sections of the prefill input taken from an aggregated
 * dashboard period instead of the period data. The Manager-payment section
 * is not in the dashboard (P36: no payee names), so it is passed in. With the
 * same period, `figuresFromPeriodData` gives the same figures from either
 * source (tested; expense lines are sorted by category here, in ledger order
 * there).
 */
export function periodReportInputFromFundValues(
  v: FundValues,
  managerAndAffiliatePayments: PeriodReportInput["managerAndAffiliatePayments"],
): PeriodReportInput {
  return {
    revenue: {
      grossRevenueCents: cents(v.grossRevenue),
      averageUtilizationBps: v.utilizationBps,
    },
    expenses: {
      totalCents: cents(v.totalExpenses),
      byCategory: v.expensesByCategory.map((c) => ({
        category: c.category.slice(0, 200),
        amountCents: cents(c.amount),
      })),
    },
    managementFee: {
      accruedCents: cents(v.managementFeeAccrued),
      paidCents: cents(v.managementFeePaid),
      unpaidAtEndCents: cents(v.managementFeeUnpaid),
    },
    reserves: {
      balanceAtEndCents: cents(v.reserveBalance),
      minimumRequiredCents: cents(v.minimumReserve),
    },
    distributions: {
      totalGrossCents: cents(v.distributions.gross),
      tierCCents: cents(v.distributions.preferredReturn),
      tierDCents: cents(v.distributions.returnOfCapital),
      tierECents: cents(
        v.distributions.residualPreferred + v.distributions.residualCommon,
      ),
    },
    managerAndAffiliatePayments,
  };
}

export interface FigureDifference {
  /** dotted path of the figure ("revenue.amountCents", "expenses.lines.COLOCATION", "managerPayments.lines[…]") */
  field: string;
  /** the stored report value; null when missing from the report */
  reportCents: number | null;
  /** the ledger value; null when the ledger has no such line */
  ledgerCents: number | null;
}

function lineTotals<T>(
  rows: readonly T[],
  key: (r: T) => string,
  amount: (r: T) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + amount(r));
  return out;
}

function compareLines(
  out: FigureDifference[],
  field: string,
  report: Map<string, number>,
  ledger: Map<string, number>,
): void {
  const keys = [...new Set([...report.keys(), ...ledger.keys()])].sort();
  for (const k of keys) {
    const r = report.get(k) ?? null;
    const l = ledger.get(k) ?? null;
    if (r !== l)
      out.push({ field: `${field}[${k}]`, reportCents: r, ledgerCents: l });
  }
}

/**
 * P38: the ledger-derived figures of `figures` that differ from the period
 * data of the same period. Empty when the report may be released. Every
 * difference counts, one cent included; notes and the fields listed at the
 * top of this file are ignored. Lines are compared as sets (keyed by their
 * identifying text), not by position.
 */
export function reconcileFigures(
  figures: ReportFigures,
  periodEconomics: PeriodEconomics,
): FigureDifference[] {
  const ledger = figuresFromPeriodData(
    periodReportInputFromEconomics(periodEconomics),
    {
      start: periodEconomics.period.periodStart,
      end: periodEconomics.period.periodEnd,
    },
    "",
  );
  const out: FigureDifference[] = [];
  const scalar = (field: string, r: number | null, l: number | null): void => {
    if (r !== l) out.push({ field, reportCents: r, ledgerCents: l });
  };

  scalar(
    "revenue.amountCents",
    figures.revenue.amountCents,
    ledger.revenue.amountCents,
  );
  scalar(
    "expenses.totalCents",
    figures.expenses.totalCents,
    ledger.expenses.totalCents,
  );
  compareLines(
    out,
    "expenses.lines",
    lineTotals(
      figures.expenses.lines,
      (l) => l.category,
      (l) => l.amountCents,
    ),
    lineTotals(
      ledger.expenses.lines,
      (l) => l.category,
      (l) => l.amountCents,
    ),
  );
  for (const k of ["accruedCents", "paidCents", "unpaidAtEndCents"] as const) {
    scalar(
      `managementFee.${k}`,
      figures.managementFee[k],
      ledger.managementFee[k],
    );
  }
  for (const k of ["balanceCents", "minimumRequiredCents"] as const) {
    scalar(`reserves.${k}`, figures.reserves[k], ledger.reserves[k]);
  }
  for (const k of [
    "totalCents",
    "preferredReturnCents",
    "returnOfCapitalCents",
    "residualCents",
  ] as const) {
    scalar(
      `distributions.${k}`,
      figures.distributions[k],
      ledger.distributions[k],
    );
  }

  // The report page shows "No distribution this quarter" instead of the
  // amounts when the flag is set, so the flag must not hide a distribution.
  if (figures.distributions.none && !ledger.distributions.none) {
    out.push({
      field: "distributions.none",
      reportCents: 0,
      ledgerCents: ledger.distributions.totalCents,
    });
  }

  const mpR = figures.managerPayments;
  const mpL = ledger.managerPayments;
  const paymentKey = (p: ReportFigures["managerPayments"]["lines"][number]) =>
    [
      p.paidOn,
      p.payee,
      p.category,
      p.flow,
      p.memo ?? "",
      p.resolutionId ?? "",
    ].join(" | ");
  compareLines(
    out,
    "managerPayments.lines",
    lineTotals(mpR.lines, paymentKey, (p) => p.amountCents),
    lineTotals(mpL.lines, paymentKey, (p) => p.amountCents),
  );
  const insiderKey = (
    d: ReportFigures["managerPayments"]["insiderDistributions"][number],
  ) => `${d.paymentDate} | ${d.name}`;
  compareLines(
    out,
    "managerPayments.insiderDistributions",
    lineTotals(mpR.insiderDistributions, insiderKey, (d) => d.netCents),
    lineTotals(mpL.insiderDistributions, insiderKey, (d) => d.netCents),
  );
  const loanKey = (
    l: ReportFigures["managerPayments"]["insiderLoanPayments"][number],
  ) => `${l.paidOn} | ${l.name}`;
  compareLines(
    out,
    "managerPayments.insiderLoanPayments.principal",
    lineTotals(mpR.insiderLoanPayments, loanKey, (l) => l.principalCents),
    lineTotals(mpL.insiderLoanPayments, loanKey, (l) => l.principalCents),
  );
  compareLines(
    out,
    "managerPayments.insiderLoanPayments.interest",
    lineTotals(mpR.insiderLoanPayments, loanKey, (l) => l.interestCents),
    lineTotals(mpL.insiderLoanPayments, loanKey, (l) => l.interestCents),
  );
  scalar(
    "managerPayments.grandTotalCents",
    mpR.grandTotalCents,
    mpL.grandTotalCents,
  );
  return out;
}
