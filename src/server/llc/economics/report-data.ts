import "server-only";

import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { CashLedger } from "@/lib/llc/available-cash";
import type { IsoDate } from "@/lib/llc/dates";
import type { TPrismaOrTransaction } from "@/server/db";
import { getLoanStates, loadCashLedger } from "./financials";
import {
  buildPeriodEconomics,
  type PeriodEconomics,
} from "./report-data.logic";
import { notFound, ruleViolation } from "./scope";
import { getEconomicsContext } from "./term";

type Tx = TPrismaOrTransaction;

export type { PeriodEconomics };

const d = toDateOnly;

/**
 * §8.2 period data (E19, R24). Read only. `cashLedger` lets a caller that
 * already loaded the company's cash ledger share it.
 */
export async function getPeriodEconomics(
  tx: Tx,
  companyId: string,
  period: { periodStart: IsoDate; periodEnd: IsoDate },
  shared?: { cashLedger?: CashLedger },
): Promise<PeriodEconomics> {
  if (period.periodStart > period.periodEnd) {
    ruleViolation("The period start must not be after the period end.");
  }
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  const { term, config } = await getEconomicsContext(tx, company);
  const start = fromDateOnly(period.periodStart);
  const end = fromDateOnly(period.periodEnd);

  const [
    cashLedger,
    utilization,
    managerPayments,
    distributions,
    loanPayments,
    stakeholders,
    loans,
  ] = await Promise.all([
    shared?.cashLedger ?? loadCashLedger(tx, companyId),
    tx.revenuePeriod.findMany({
      where: { companyId, month: { gte: start, lte: end } },
      select: { month: true, utilizationBps: true },
    }),
    tx.managerPayment.findMany({
      where: { companyId },
      orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
    }),
    tx.distribution.findMany({
      where: {
        companyId,
        status: "FINALIZED",
        isReversal: false,
        paymentDate: { gte: start, lte: end },
      },
      select: {
        id: true,
        number: true,
        type: true,
        paymentDate: true,
        amountCents: true,
        tierCCents: true,
        tierDCents: true,
        tierEPreferredCents: true,
        tierECommonCents: true,
        totalNetCents: true,
        lines: {
          select: { stakeholderId: true, grossCents: true, netCents: true },
        },
      },
    }),
    tx.memberLoanPayment.findMany({
      where: { companyId, paidOn: { gte: start, lte: end } },
      select: {
        paidOn: true,
        principalCents: true,
        interestCents: true,
        memberLoan: { select: { lenderStakeholderId: true } },
      },
    }),
    tx.stakeholder.findMany({
      where: { companyId },
      select: { id: true, name: true, isInsider: true },
    }),
    getLoanStates(tx, companyId, period.periodEnd),
  ]);

  let memberLoansOutstandingAtEnd = 0n;
  for (const l of loans) memberLoansOutstandingAtEnd += l.principalOutstanding;

  return buildPeriodEconomics({
    period: { periodStart: period.periodStart, periodEnd: period.periodEnd },
    ledger: cashLedger,
    utilization: utilization.map((u) => ({
      month: d(u.month),
      utilizationBps: u.utilizationBps,
    })),
    managerPayments: managerPayments.map((p) => ({
      id: p.id,
      paidOn: d(p.paidOn),
      payee: p.payee,
      category: p.category,
      amountCents: p.amountCents,
      countsTowardOrgCap: p.countsTowardOrgCap,
      memo: p.memo,
      resolutionId: p.resolutionId,
    })),
    distributions: distributions.map((x) => ({
      id: x.id,
      number: x.number ?? 0,
      type: x.type,
      paymentDate: d(x.paymentDate),
      gross: x.amountCents ?? 0n,
      tierC: x.tierCCents ?? 0n,
      tierD: x.tierDCents ?? 0n,
      tierEPreferred: x.tierEPreferredCents ?? 0n,
      tierECommon: x.tierECommonCents ?? 0n,
      net: x.totalNetCents ?? 0n,
      lines: x.lines.map((l) => ({
        stakeholderId: l.stakeholderId,
        gross: l.grossCents,
        net: l.netCents,
      })),
    })),
    loanPayments: loanPayments.map((p) => ({
      lenderStakeholderId: p.memberLoan.lenderStakeholderId,
      paidOn: d(p.paidOn),
      principal: p.principalCents,
      interest: p.interestCents,
    })),
    holders: new Map(
      stakeholders.map((s) => [s.id, { name: s.name, isInsider: s.isInsider }]),
    ),
    includeInsiderDistributions:
      config.includeInsiderDistributionsInManagerList,
    minimumOperatingReserve: term.minimumOperatingReserveCents,
    orgExpenseCap: term.orgExpenseCapCents,
    memberLoansOutstandingAtEnd,
  });
}
