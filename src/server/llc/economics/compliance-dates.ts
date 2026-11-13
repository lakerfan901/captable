import "server-only";

import { toDateOnly } from "@/lib/date-only";
import {
  type CashLedger,
  computeAvailableCash,
} from "@/lib/llc/available-cash";
import { compareIso, type IsoDate, quarterOf } from "@/lib/llc/dates";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  type CommitmentState,
  getCommitmentStates,
  getLineStates,
  type LineState,
} from "./call-notices";
import {
  buildComplianceDates,
  type ComplianceDate,
  complianceQuarterEnds,
} from "./compliance-dates.logic";
import { listDefaults } from "./defaults";
import { getLoanStates, loadCashLedger } from "./financials";
import { notFound } from "./scope";
import { getEconomicsContext, getTermClock } from "./term";

type Tx = TPrismaOrTransaction;

export type { ComplianceDate };

/** Rows a caller (the Overview) already loaded; anything missing is loaded here. */
export interface ComplianceShared {
  cashLedger?: CashLedger;
  lineStates?: LineState[];
  commitmentStates?: CommitmentState[];
}

/**
 * Computed compliance dates in [range.from, range.to] (E19 table). Read only.
 * GOVERNANCE treats DONE and NOT_REQUIRED as done and skips
 * QUARTERLY_REPORT_DEADLINE and INFO.
 */
export async function getComplianceDates(
  tx: Tx,
  companyId: string,
  range: { from: IsoDate; to: IsoDate },
  shared?: ComplianceShared,
): Promise<ComplianceDate[]> {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  const { term, config, today } = await getEconomicsContext(tx, company);

  const [
    cashLedger,
    clock,
    firstReceipt,
    lineStates,
    commitmentStates,
    defaults,
    defaultRows,
    loans,
  ] = await Promise.all([
    shared?.cashLedger ?? loadCashLedger(tx, companyId),
    getTermClock(tx, companyId),
    tx.capitalReceipt.findFirst({
      where: { companyId, voidedAt: null, appliedOn: { not: null } },
      orderBy: { appliedOn: "asc" },
      select: { appliedOn: true },
    }),
    shared?.lineStates ?? getLineStates(tx, companyId, today),
    shared?.commitmentStates ?? getCommitmentStates(tx, companyId),
    listDefaults(tx, companyId, today),
    tx.memberDefault.findMany({
      where: { companyId },
      select: {
        id: true,
        forfeitureConfirmedAt: true,
        creditConfirmedAt: true,
      },
    }),
    getLoanStates(tx, companyId, today),
  ]);

  const firstReceiptOn = firstReceipt?.appliedOn
    ? toDateOnly(firstReceipt.appliedOn)
    : null;

  // Available Cash and distributions per ended quarter, from the shared cash ledger.
  const quarters = complianceQuarterEnds(firstReceiptOn, range, config)
    .filter((q) => compareIso(q.quarterEnd, today) < 0)
    .map((q) => {
      const { start } = quarterOf(q.quarterEnd);
      return {
        quarterEnd: q.quarterEnd,
        hasDistribution: cashLedger.distributions.some(
          (x) =>
            x.type !== "RETURN_OF_UNUSED_CAPITAL" &&
            compareIso(x.on, start) >= 0 &&
            compareIso(x.on, q.quarterEnd) <= 0,
        ),
        availableCash: computeAvailableCash(cashLedger, q.quarterEnd)
          .availableCash,
      };
    });

  const confirmed = new Map(defaultRows.map((r) => [r.id, r]));

  return buildComplianceDates({
    today,
    range,
    config,
    clock,
    firstReceiptOn,
    quarters,
    callLines: lineStates
      .filter((l) => l.status === "SENT")
      .map((l) => ({
        id: l.lineId,
        dueOn: l.dueOn,
        outstanding: l.outstanding,
      })),
    anyUncalledBalance: commitmentStates.some((c) => c.uncalled > 0n),
    defaults: defaults.map((x) => ({
      id: x.id,
      status: x.status,
      memberName: x.memberName,
      forfeitureDate: x.forfeitureDate,
      forfeitureConfirmed: confirmed.get(x.id)?.forfeitureConfirmedAt != null,
      creditDate: x.creditDate,
      creditConfirmed: confirmed.get(x.id)?.creditConfirmedAt != null,
      outstanding: x.outstandingBalance,
    })),
    loans: loans.map((l) => ({
      id: l.loanId,
      maturityOn: l.maturityOn,
      principalOutstanding: l.principalOutstanding,
    })),
    ocdNoticeSentOn:
      term.ocdNoticeSentOn === null ? null : toDateOnly(term.ocdNoticeSentOn),
  });
}
