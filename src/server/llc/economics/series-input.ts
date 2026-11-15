import "server-only";

import { toDateOnly } from "@/lib/date-only";
import { compareIso, type IsoDate } from "@/lib/llc/dates";
import type { MonthKey } from "@/lib/llc/financial-periods";
import {
  type AsOfFacts,
  type HolderSeriesRows,
  type MemberLoanRows,
  type SeriesInput,
  seriesAsOfDates,
} from "@/lib/llc/financial-series-build";
import { seriesInception } from "@/lib/llc/financial-snapshot-core";
import { type MicroUnits, microUnitsFromDecimal } from "@/lib/llc/money";
import type { TPrismaOrTransaction } from "@/server/db";
import { getMemberPositions } from "@/server/llc/positions";
import { unitsToWire } from "@/server/llc/serialize";
import {
  type AsOfCut,
  getCommitmentStates,
  getLineStates,
} from "./call-notices";
import { loadCashLedger } from "./financials";
import { loadAccrualPauses, loadLedger } from "./ledger";
import { notFound } from "./scope";
import type {
  StatementCommitment,
  StatementDistributionRow,
  StatementReceiptRow,
  StatementTransferRow,
} from "./statements.logic";
import { getEconomicsContext } from "./term";
import { loadCompletedTransfers } from "./transfers";

// The database side of the financial series (04-investor-portal.md 5.9;
// package P13a): reads everything `buildSeries` needs, as the existing
// services read it, so a month record equals what `getPeriodEconomics` and
// `getMemberStatement` return for that month:
//
// - `economics`: the inputs of `getPeriodEconomics`, over the whole history
//   (`buildPeriodEconomics` filters by period itself);
// - `events`, `accrualPauses`: as `getPositions` builds positions;
// - holder rows: as `getMemberStatement` loads them (Preferred receipts,
//   finalized distribution lines, completed transfers, tax advances);
// - `facts` per as-of date: each holder's commitment as `getMemberStatement`
//   loads it (`loadCommitment`: cut at the date when it is before today) and
//   Common Units as `getPositions` reads them (`getMemberPositions`, COMMON).
//   One set of queries per date for all holders (not per holder).
//
// Read only. Used inside the release transaction (under the ledger lock) and
// by the team's live view (P13b). Server only: portal procedures never
// import it (S26).

type Tx = TPrismaOrTransaction;
const d = toDateOnly;
const CASH_KINDS = ["INITIAL", "BALANCE", "REPLACEMENT"] as const;

/** Everything but the per-date facts. */
export interface SeriesBase {
  companyId: string;
  preferredClassId: string;
  today: IsoDate;
  input: Omit<SeriesInput, "facts">;
  /** P34: the month of the earliest dated row (receipts of both classes included); null on an empty ledger */
  inception: MonthKey | null;
  replacements: {
    id: string;
    stakeholderId: string;
    acceptedOn: IsoDate | null;
    acceptedCents: bigint;
  }[];
  replacementCash: {
    commitmentId: string;
    appliedOn: IsoDate | null;
    appliedCents: bigint;
  }[];
}

/**
 * Loads the whole history of the company. `today` defaults to the
 * company's economics "today"; release passes its own (the month records it
 * writes have all ended before it).
 */
export async function loadSeriesBase(
  tx: Tx,
  companyId: string,
  opts: { today?: IsoDate } = {},
): Promise<SeriesBase> {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  const ctx = await getEconomicsContext(tx, company);
  const { term, config, preferredClass } = ctx;
  const today = opts.today ?? ctx.today;

  const [
    cashLedger,
    utilization,
    managerPayments,
    distributions,
    loanPayments,
    stakeholders,
    loans,
    ledger,
    accrualPauses,
    receipts,
    lines,
    transfers,
    advances,
    firstReceipt,
    replacements,
  ] = await Promise.all([
    loadCashLedger(tx, companyId),
    tx.revenuePeriod.findMany({
      where: { companyId },
      select: { month: true, utilizationBps: true },
    }),
    tx.managerPayment.findMany({
      where: { companyId },
      orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
    }),
    tx.distribution.findMany({
      where: { companyId, status: "FINALIZED", isReversal: false },
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
      where: { companyId },
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
    tx.memberLoan.findMany({
      where: { companyId },
      orderBy: [{ madeOn: "asc" }, { createdAt: "asc" }],
      include: {
        payments: {
          select: { paidOn: true, principalCents: true, interestCents: true },
        },
      },
    }),
    loadLedger(tx, companyId, config),
    config.accrueOnDefaulterCapital
      ? Promise.resolve([])
      : loadAccrualPauses(tx, companyId),
    tx.capitalReceipt.findMany({
      where: {
        companyId,
        unitClassId: preferredClass.id,
        voidedAt: null,
        appliedOn: { not: null },
      },
      orderBy: [{ appliedOn: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        stakeholderId: true,
        kind: true,
        receivedOn: true,
        appliedOn: true,
        appliedCents: true,
        unitsIssued: true,
        prefReturnStartDate: true,
      },
    }),
    tx.distributionLine.findMany({
      where: {
        companyId,
        distribution: { status: "FINALIZED", isReversal: false },
      },
      select: {
        stakeholderId: true,
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
    }),
    loadCompletedTransfers(tx, companyId),
    tx.memberAdvance.findMany({
      where: { companyId },
      orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        stakeholderId: true,
        paidOn: true,
        kind: true,
        amountCents: true,
      },
    }),
    // Inception: the first receipt of either class (Common issuances included).
    tx.capitalReceipt.findFirst({
      where: { companyId, voidedAt: null },
      orderBy: { receivedOn: "asc" },
      select: { receivedOn: true },
    }),
    tx.commitment.findMany({
      where: {
        companyId,
        unitClassId: preferredClass.id,
        status: { in: ["ACCEPTED", "REDUCED"] },
        isReplacement: true,
      },
      select: {
        id: true,
        stakeholderId: true,
        acceptedOn: true,
        acceptedCents: true,
      },
    }),
  ]);

  const replacementCash =
    replacements.length === 0
      ? []
      : await tx.capitalReceipt.findMany({
          where: {
            companyId,
            commitmentId: { in: replacements.map((r) => r.id) },
            voidedAt: null,
            kind: { in: [...CASH_KINDS] },
          },
          select: { commitmentId: true, appliedOn: true, appliedCents: true },
        });

  // Holder rows, as getMemberStatement loads them.
  const names = new Map(stakeholders.map((s) => [s.id, s.name]));
  const rows = new Map<
    string,
    {
      receipts: StatementReceiptRow[];
      distributions: StatementDistributionRow[];
      transfers: StatementTransferRow[];
      advances: HolderSeriesRows["advances"][number][];
    }
  >();
  const rowsOf = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { receipts: [], distributions: [], transfers: [], advances: [] };
      rows.set(id, r);
    }
    return r;
  };
  for (const r of receipts) {
    if (r.appliedOn === null) continue;
    rowsOf(r.stakeholderId).receipts.push({
      id: r.id,
      kind: r.kind,
      on: d(r.kind === "FORFEITURE" ? r.receivedOn : r.appliedOn),
      amount: r.appliedCents,
      units: microUnitsFromDecimal(unitsToWire(r.unitsIssued)),
      receivedOn: d(r.receivedOn),
      accrualStartOn:
        r.prefReturnStartDate === null ? null : d(r.prefReturnStartDate),
    });
  }
  for (const l of lines) {
    rowsOf(l.stakeholderId).distributions.push({
      distributionId: l.distribution.id,
      number: l.distribution.number ?? 0,
      type: l.distribution.type,
      paymentDate: d(l.distribution.paymentDate),
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
    });
  }
  const nameOf = (id: string) => names.get(id) ?? id;
  for (const t of transfers) {
    rowsOf(t.toStakeholderId).transfers.push({
      id: t.id,
      on: t.effectiveOn,
      direction: "IN",
      counterparty: nameOf(t.fromStakeholderId),
      units: t.units,
    });
    rowsOf(t.fromStakeholderId).transfers.push({
      id: t.id,
      on: t.effectiveOn,
      direction: "OUT",
      counterparty: nameOf(t.toStakeholderId),
      units: t.units,
    });
  }
  for (const a of advances) {
    rowsOf(a.stakeholderId).advances.push({
      id: a.id,
      on: d(a.paidOn),
      kind: a.kind,
      amount: a.amountCents,
    });
  }
  const holders: HolderSeriesRows[] = [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([holderId, r]) => ({ holderId, name: nameOf(holderId), ...r }));

  const memberLoans: MemberLoanRows[] = loans.map((l) => ({
    loan: {
      madeOn: d(l.madeOn),
      maturityOn: d(l.maturityOn),
      principalCents: l.principalCents,
      interestBps: l.interestBps,
    },
    payments: l.payments.map((p) => ({
      paidOn: d(p.paidOn),
      principalCents: p.principalCents,
      interestCents: p.interestCents,
    })),
  }));

  const input: Omit<SeriesInput, "facts"> = {
    today,
    economics: {
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
        stakeholders.map((s) => [
          s.id,
          { name: s.name, isInsider: s.isInsider },
        ]),
      ),
      includeInsiderDistributions:
        config.includeInsiderDistributionsInManagerList,
      minimumOperatingReserve: term.minimumOperatingReserveCents,
      orgExpenseCap: term.orgExpenseCapCents,
    },
    events: ledger.events,
    positionsConfig: config,
    accrualPauses,
    memberLoans,
    holders,
  };

  return {
    companyId,
    preferredClassId: preferredClass.id,
    today,
    input,
    inception: seriesInception(
      { ...input, facts: new Map() },
      firstReceipt ? [d(firstReceipt.receivedOn)] : [],
    ),
    replacements: replacements.map((r) => ({
      id: r.id,
      stakeholderId: r.stakeholderId,
      acceptedOn: r.acceptedOn === null ? null : d(r.acceptedOn),
      acceptedCents: r.acceptedCents,
    })),
    replacementCash: replacementCash.flatMap((c) =>
      c.commitmentId === null
        ? []
        : [
            {
              commitmentId: c.commitmentId,
              appliedOn: c.appliedOn === null ? null : d(c.appliedOn),
              appliedCents: c.appliedCents,
            },
          ],
    ),
  };
}

/**
 * Commitment and Common Unit facts as of one date for every holder, with the
 * figures `getMemberStatement` would load for a statement ending on it.
 */
async function factsAsOf(
  tx: Tx,
  base: SeriesBase,
  asOf: IsoDate,
): Promise<AsOfFacts> {
  const { companyId, today } = base;
  // getMemberStatement: a past statement date cuts the call ledger at it.
  const cut: AsOfCut | undefined =
    compareIso(asOf, today) < 0 ? { on: asOf } : undefined;
  const cutOn = cut ? cut.on : null;
  const within = (on: IsoDate | null) =>
    cutOn === null || (on !== null && compareIso(on, cutOn) <= 0);

  const [states, lines, positions] = await Promise.all([
    getCommitmentStates(tx, companyId, cut ? { asOf: cut } : undefined),
    getLineStates(
      tx,
      companyId,
      cut ? cut.on : today,
      cut ? { asOf: cut } : undefined,
    ),
    getMemberPositions(tx, companyId, { asOf }),
  ]);

  // getCapitalTotals: Replacement Funder commitments accepted by the cut,
  // and their cash applied by it.
  const replacements = base.replacements.filter((r) => within(r.acceptedOn));
  const cashOf = new Map<string, bigint>();
  const counted = new Set(replacements.map((r) => r.id));
  for (const c of base.replacementCash) {
    if (!counted.has(c.commitmentId) || !within(c.appliedOn)) continue;
    cashOf.set(
      c.commitmentId,
      (cashOf.get(c.commitmentId) ?? 0n) + c.appliedCents,
    );
  }

  const holderIds = new Set<string>([
    ...states.map((s) => s.stakeholderId),
    ...replacements.map((r) => r.stakeholderId),
  ]);
  const commitments = new Map<string, StatementCommitment | null>();
  for (const id of holderIds) {
    const own = states.filter((s) => s.stakeholderId === id);
    let committed = 0n;
    let paid = 0n;
    let uncalled = 0n;
    for (const s of own) {
      committed += s.acceptedCents;
      paid += s.totalPaid;
      uncalled += s.uncalled;
    }
    for (const r of replacements) {
      if (r.stakeholderId !== id) continue;
      committed += r.acceptedCents;
      paid += cashOf.get(r.id) ?? 0n;
    }
    if (own.length === 0 && committed === 0n && paid === 0n) continue;
    const ownCommitments = new Set(own.map((s) => s.commitmentId));
    let calledOutstanding = 0n;
    for (const l of lines) {
      if (!ownCommitments.has(l.commitmentId)) continue;
      if (
        (l.status === "SENT" || l.status === "SENDING") &&
        l.outstanding > 0n
      ) {
        calledOutstanding += l.outstanding;
      }
    }
    commitments.set(id, { committed, paid, uncalled, calledOutstanding });
  }

  const commonUnits = new Map<string, MicroUnits>();
  for (const row of positions) {
    if (row.kind !== "COMMON") continue;
    commonUnits.set(
      row.stakeholderId,
      (commonUnits.get(row.stakeholderId) ?? 0n) +
        microUnitsFromDecimal(row.units),
    );
  }
  return { commitments, commonUnits };
}

/** The base plus the facts for every as-of date of [from, to] (`seriesAsOfDates`). */
export async function withFacts(
  tx: Tx,
  base: SeriesBase,
  range: { from: MonthKey; to: MonthKey },
): Promise<SeriesInput> {
  const facts = new Map<IsoDate, AsOfFacts>();
  for (const asOf of seriesAsOfDates(range.from, range.to, base.today)) {
    if (!facts.has(asOf)) facts.set(asOf, await factsAsOf(tx, base, asOf));
  }
  return { ...base.input, facts };
}

/** `loadSeriesBase` + `withFacts`: the input of `buildSeries` for [from, to]. */
export async function loadSeriesInput(
  tx: Tx,
  companyId: string,
  range: { from: MonthKey; to: MonthKey },
  opts: { today?: IsoDate } = {},
): Promise<{ input: SeriesInput; inception: MonthKey | null }> {
  const base = await loadSeriesBase(tx, companyId, opts);
  return { input: await withFacts(tx, base, range), inception: base.inception };
}
