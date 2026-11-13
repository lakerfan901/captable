import "server-only";

import { toDateOnly } from "@/lib/date-only";
import { addDays, type IsoDate } from "@/lib/llc/dates";
import {
  type Cents,
  LlcMathError,
  type MicroUnits,
  microUnitsFromDecimal,
} from "@/lib/llc/money";
import type { TPrismaOrTransaction } from "@/server/db";
import { unitsToWire } from "@/server/llc/serialize";
import { getCommitmentStates, getLineStates } from "./call-notices";
import { listDefaults } from "./defaults";
import {
  getFinancialSummary,
  getLoanStates,
  getTaxAdvancesOutstanding,
} from "./financials";
import { getPositions } from "./ledger";
import { notFound, ruleViolation } from "./scope";
import {
  buildMemberStatement,
  computeFairValue,
  type FairValueResult,
  type FairValueUnitClass,
  type MemberStatement,
  memberLoansOwed,
  type StatementCommitment,
  type StatementDistributionRow,
  type StatementReceiptRow,
  type StatementTransferRow,
} from "./statements.logic";
import { getEconomicsContext } from "./term";
import { loadCompletedTransfers } from "./transfers";

export type {
  FairValueLine,
  FairValueResult,
  FairValueSelected,
  FairValueUnitClass,
  MemberStatement,
  StatementActivity,
  StatementBalances,
} from "./statements.logic";

type Tx = TPrismaOrTransaction;

/** Runs pure library code; an LlcMathError becomes a BAD_REQUEST naming its code. */
function math<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LlcMathError) {
      ruleViolation(`${error.message} (${error.code}).`);
    }
    throw error;
  }
}

async function companyOf(tx: Tx, companyId: string) {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  return company;
}

async function loadCommitment(
  tx: Tx,
  companyId: string,
  stakeholderId: string,
  today: IsoDate,
): Promise<StatementCommitment | null> {
  const states = (await getCommitmentStates(tx, companyId)).filter(
    (s) => s.stakeholderId === stakeholderId,
  );
  if (states.length === 0) return null;
  let committed = 0n;
  let paid = 0n;
  let uncalled = 0n;
  let calledOutstanding = 0n;
  for (const s of states) {
    committed += s.acceptedCents;
    paid += s.totalPaid;
    uncalled += s.uncalled;
    const lines = await getLineStates(tx, companyId, today, {
      commitmentId: s.commitmentId,
    });
    for (const l of lines) {
      if (
        (l.status === "SENT" || l.status === "SENDING") &&
        l.outstanding > 0n
      ) {
        calledOutstanding += l.outstanding;
      }
    }
  }
  return { committed, paid, uncalled, calledOutstanding };
}

/**
 * Member statement for [from, to] (E18): opening balances as of the day before
 * `from`, closing balances as of `to`, the period's movements and activity.
 * Read only. The caller verifies the stakeholder belongs to the company.
 */
export async function getMemberStatement(
  tx: Tx,
  companyId: string,
  stakeholderId: string,
  range: { from: IsoDate; to: IsoDate },
): Promise<MemberStatement> {
  const { from, to } = range;
  if (from > to)
    ruleViolation("The start date must not be after the end date.");
  const company = await companyOf(tx, companyId);
  const { today, preferredClass } = await getEconomicsContext(tx, company);

  const openingAsOf = addDays(from, -1);
  const opening = await getPositions(tx, companyId, openingAsOf);
  const closing = await getPositions(tx, companyId, to);
  const holder = closing.ledger.holders.get(stakeholderId);
  if (!holder) notFound("Member");

  const receiptRows = await tx.capitalReceipt.findMany({
    where: {
      companyId,
      stakeholderId,
      unitClassId: preferredClass.id,
      voidedAt: null,
      appliedOn: { not: null },
    },
    orderBy: [{ appliedOn: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      kind: true,
      receivedOn: true,
      appliedOn: true,
      appliedCents: true,
      unitsIssued: true,
    },
  });
  const receipts: StatementReceiptRow[] = [];
  for (const r of receiptRows) {
    if (r.appliedOn === null) continue;
    receipts.push({
      id: r.id,
      kind: r.kind,
      // Dated as the ledger dates them (receiptsToEvents).
      on: toDateOnly(r.kind === "FORFEITURE" ? r.receivedOn : r.appliedOn),
      amount: r.appliedCents,
      units: microUnitsFromDecimal(unitsToWire(r.unitsIssued)),
    });
  }

  // Same filter as loadLedger: a reversed distribution and its reversal are both excluded.
  const lineRows = await tx.distributionLine.findMany({
    where: {
      companyId,
      stakeholderId,
      distribution: { status: "FINALIZED", isReversal: false },
    },
    select: {
      tierCCents: true,
      tierDCents: true,
      tierEPreferredCents: true,
      tierECommonCents: true,
      grossCents: true,
      defaultOffsetBalanceCents: true,
      defaultOffsetInterestCents: true,
      defaultOffsetCostsCents: true,
      taxAdvanceOffsetCents: true,
      netCents: true,
      distribution: {
        select: { id: true, number: true, type: true, paymentDate: true },
      },
    },
  });
  const distributions: StatementDistributionRow[] = lineRows.map((l) => ({
    distributionId: l.distribution.id,
    number: l.distribution.number ?? 0,
    type: l.distribution.type,
    paymentDate: toDateOnly(l.distribution.paymentDate),
    tierC: l.tierCCents,
    tierD: l.tierDCents,
    tierEPreferred: l.tierEPreferredCents,
    tierECommon: l.tierECommonCents,
    gross: l.grossCents,
    defaultOffset:
      l.defaultOffsetBalanceCents +
      l.defaultOffsetInterestCents +
      l.defaultOffsetCostsCents,
    taxAdvanceOffset: l.taxAdvanceOffsetCents,
    net: l.netCents,
  }));

  const nameOf = (id: string) => closing.ledger.holders.get(id)?.name ?? id;
  const transfers: StatementTransferRow[] = [];
  for (const t of await loadCompletedTransfers(tx, companyId)) {
    if (t.toStakeholderId === stakeholderId) {
      transfers.push({
        id: t.id,
        on: t.effectiveOn,
        direction: "IN",
        counterparty: nameOf(t.fromStakeholderId),
        units: t.units,
      });
    } else if (t.fromStakeholderId === stakeholderId) {
      transfers.push({
        id: t.id,
        on: t.effectiveOn,
        direction: "OUT",
        counterparty: nameOf(t.toStakeholderId),
        units: t.units,
      });
    }
  }

  const advances = (
    await tx.memberAdvance.findMany({
      where: { companyId, stakeholderId },
      orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
      select: { id: true, paidOn: true, kind: true, amountCents: true },
    })
  ).map((a) => ({
    id: a.id,
    on: toDateOnly(a.paidOn),
    kind: a.kind,
    amount: a.amountCents,
  }));

  const defaults = (await listDefaults(tx, companyId, today))
    .filter((d) => d.stakeholderId === stakeholderId && d.status !== "VOIDED")
    .map((d) => ({
      memberDefaultId: d.id,
      status: d.status,
      outstandingBalance: d.outstandingBalance,
      interestOwed: d.interestOwed,
      costsOwed: d.costsOwed,
    }));

  const commitment = await loadCommitment(tx, companyId, stakeholderId, today);
  const taxAdvanceOutstanding =
    (await getTaxAdvancesOutstanding(tx, companyId)).get(stakeholderId) ?? 0n;

  return math(() =>
    buildMemberStatement({
      stakeholderId,
      name: holder.name,
      from,
      to,
      openingPosition: opening.positions.holders.get(stakeholderId),
      closingPosition: closing.positions.holders.get(stakeholderId),
      openingCommonUnits: opening.ledger.commonUnits.get(stakeholderId) ?? 0n,
      closingCommonUnits: closing.ledger.commonUnits.get(stakeholderId) ?? 0n,
      openingTotalPreferredUnits: opening.positions.totals.preferredUnits,
      closingTotalPreferredUnits: closing.positions.totals.preferredUnits,
      receipts,
      distributions,
      transfers,
      advances,
      commitment,
      defaults,
      taxAdvanceOutstanding,
    }),
  );
}

export interface FairValueQuery {
  asOf: IsoDate;
  assetFmv: Cents;
  cashOnHand: Cents;
  liabilities: Cents;
  includeMemberLoans: boolean;
  selection: {
    stakeholderId: string;
    unitClass?: FairValueUnitClass;
    unitsValued?: MicroUnits;
  } | null;
}

/** R43 calculator: hypothetical liquidation on positions as of `asOf`. Nothing is stored. */
export async function getFairValue(
  tx: Tx,
  companyId: string,
  q: FairValueQuery,
): Promise<
  FairValueResult & {
    asOf: IsoDate;
    prefill: {
      unpaidManagementFee: Cents;
      memberLoans: Cents;
      reserves: Cents;
      availableCashRaw: Cents;
    };
  }
> {
  const { ledger, waterfallHolders, config } = await getPositions(
    tx,
    companyId,
    q.asOf,
  );
  const summary = await getFinancialSummary(tx, companyId, q.asOf);
  const memberLoans = memberLoansOwed(
    await getLoanStates(tx, companyId, q.asOf),
  );
  const names = new Map<string, string>();
  for (const [id, h] of ledger.holders) names.set(id, h.name);

  const result = math(() =>
    computeFairValue({
      assetFmv: q.assetFmv,
      cashOnHand: q.cashOnHand,
      liabilities: q.liabilities,
      memberLoans: q.includeMemberLoans ? memberLoans : 0n,
      holders: waterfallHolders,
      residualPreferredBps: config.residualPreferredBps,
      names,
      selection: q.selection,
    }),
  );
  return {
    asOf: q.asOf,
    ...result,
    prefill: {
      unpaidManagementFee: summary.fee.toDate.unpaid,
      memberLoans,
      reserves: summary.reserves.total,
      availableCashRaw: summary.availableCash.raw,
    },
  };
}
