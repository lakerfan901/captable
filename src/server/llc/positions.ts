import type { TPrismaOrTransaction } from "@/server/db";
import {
  type ClassTotals,
  type MemberPosition,
  mergePositions,
  sumPositions,
} from "../../lib/admission/positions-merge";
import { fromDateOnly, toDateOnly } from "../../lib/date-only";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
  roundDiv,
} from "../../lib/llc/money";
import { resolveEconomicsToday } from "./economics/clock.logic";
import { dateToWire, unitsToWire } from "./serialize";

// Relative imports (except the type-only one) so the pure `foldTransfers`
// below can be unit-tested (vitest has no `@/` alias).

export type { ClassTotals, MemberPosition };

/**
 * Holdings per (stakeholder, unit class), computed from non-void receipts,
 * then COMPLETED unit transfers folded in (GOVERNANCE G16b). This is the
 * only place that sums units (B20). With `asOf` (inclusive), only
 * commitments accepted on or before it, receipts applied on or before it and
 * transfers effective on or before it count; without `asOf`, transfers
 * effective on or before today (company time zone).
 */
export async function getMemberPositions(
  db: TPrismaOrTransaction,
  companyId: string,
  opts?: { asOf?: string; unitClassId?: string },
): Promise<MemberPosition[]> {
  const positions = await receiptPositions(db, companyId, opts);
  const transfers = await loadFoldTransfers(db, companyId, opts);
  // No completed transfer in scope: the receipt positions, untouched.
  if (transfers.length === 0) return positions;
  let throughOn = opts?.asOf;
  if (throughOn === undefined) {
    const company = await db.company.findFirst({
      where: { id: companyId },
      select: { timezone: true },
    });
    throughOn = resolveEconomicsToday({
      nodeEnv: process.env.NODE_ENV,
      override: process.env.LLC_ECONOMICS_TODAY,
      timeZone: company?.timezone || "America/Denver",
      now: new Date(),
    });
  }
  const before = new Map<string, MemberPosition[]>();
  for (const t of transfers) {
    if (t.effectiveOn > throughOn) continue;
    before.set(
      t.id,
      await receiptPositions(
        db,
        companyId,
        { asOf: t.effectiveOn, unitClassId: t.unitClassId },
        t,
      ),
    );
  }
  return foldTransfers(
    positions,
    transfers,
    (t) => before.get(t.id) ?? [],
    throughOn,
  );
}

/**
 * Positions from receipts only. With `cut` (a transfer effective on `asOf`),
 * receipts applied on `asOf` count only when recorded before the transfer
 * was completed (`createdAt`, then id): the same-day order of ECONOMICS
 * `assignSeq`, which sorts a transfer by its completion time.
 */
async function receiptPositions(
  db: TPrismaOrTransaction,
  companyId: string,
  opts?: { asOf?: string; unitClassId?: string },
  cut?: { id: string; completedAt: Date },
): Promise<MemberPosition[]> {
  const asOf = opts?.asOf;
  const asOfDate = asOf === undefined ? undefined : fromDateOnly(asOf);
  const classFilter = opts?.unitClassId
    ? { unitClassId: opts.unitClassId }
    : {};
  const appliedFilter =
    asOfDate === undefined
      ? {}
      : cut === undefined
        ? { appliedOn: { lte: asOfDate } }
        : {
            OR: [
              { appliedOn: { lt: asOfDate } },
              { appliedOn: asOfDate, createdAt: { lt: cut.completedAt } },
              {
                appliedOn: asOfDate,
                createdAt: cut.completedAt,
                id: { lt: cut.id },
              },
            ],
          };

  // Commitments are loaded as rows (not grouped) because held cash depends on
  // each commitment's status, which no receipt column records.
  const [commitments, receiptGroups] = await Promise.all([
    db.commitment.findMany({
      where: { companyId, ...classFilter },
      select: {
        id: true,
        stakeholderId: true,
        unitClassId: true,
        status: true,
        committedCents: true,
        acceptedCents: true,
        acceptedOn: true,
        unitClass: { select: { kind: true } },
      },
    }),
    db.capitalReceipt.groupBy({
      by: ["commitmentId", "kind"],
      where: {
        companyId,
        ...classFilter,
        voidedAt: null,
        ...appliedFilter,
      },
      _sum: { amountCents: true, appliedCents: true, unitsIssued: true },
    }),
  ]);

  return mergePositions(
    commitments.map((c) => ({
      id: c.id,
      stakeholderId: c.stakeholderId,
      unitClassId: c.unitClassId,
      classKind: c.unitClass.kind,
      status: c.status,
      committedCents: c.committedCents,
      acceptedCents: c.acceptedCents,
      acceptedOn: dateToWire(c.acceptedOn),
    })),
    receiptGroups.map((g) => ({
      commitmentId: g.commitmentId,
      kind: g.kind,
      amountCents: g._sum.amountCents ?? 0n,
      appliedCents: g._sum.appliedCents ?? 0n,
      units: unitsToWire(g._sum.unitsIssued),
    })),
    { asOf },
  );
}

/** A COMPLETED GOVERNANCE `UnitTransfer` as the fold-in reads it. */
export interface FoldTransfer {
  id: string;
  fromStakeholderId: string;
  toStakeholderId: string;
  unitClassId: string;
  /** 6-dp string. */
  units: string;
  /** `YYYY-MM-DD`. */
  effectiveOn: string;
  /** Completion time (`completedAt`, else `createdAt`): same-day order. */
  completedAt: Date;
}

/** COMPLETED transfers in scope (class filter; `effectiveOn <= asOf`). */
async function loadFoldTransfers(
  db: TPrismaOrTransaction,
  companyId: string,
  opts?: { asOf?: string; unitClassId?: string },
): Promise<FoldTransfer[]> {
  const rows = await db.unitTransfer.findMany({
    where: {
      companyId,
      status: "COMPLETED",
      toStakeholderId: { not: null },
      ...(opts?.unitClassId ? { unitClassId: opts.unitClassId } : {}),
      effectiveOn:
        opts?.asOf === undefined
          ? { not: null }
          : { not: null, lte: fromDateOnly(opts.asOf) },
    },
    select: {
      id: true,
      fromStakeholderId: true,
      toStakeholderId: true,
      unitClassId: true,
      units: true,
      effectiveOn: true,
      completedAt: true,
      createdAt: true,
    },
  });
  const out: FoldTransfer[] = [];
  for (const r of rows) {
    // Both are filtered to non-null above.
    if (r.effectiveOn === null || r.toStakeholderId === null) continue;
    out.push({
      id: r.id,
      fromStakeholderId: r.fromStakeholderId,
      toStakeholderId: r.toStakeholderId,
      unitClassId: r.unitClassId,
      units: unitsToWire(r.units),
      effectiveOn: toDateOnly(r.effectiveOn),
      completedAt: r.completedAt ?? r.createdAt,
    });
  }
  return out;
}

/** Order in which transfers apply: `effectiveOn`, completion time, id. */
export function compareTransfers(a: FoldTransfer, b: FoldTransfer): number {
  if (a.effectiveOn !== b.effectiveOn) {
    return a.effectiveOn < b.effectiveOn ? -1 : 1;
  }
  const t = a.completedAt.getTime() - b.completedAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const keyOf = (stakeholderId: string, unitClassId: string) =>
  `${stakeholderId}\u0000${unitClassId}`;

type Delta = {
  stakeholderId: string;
  unitClassId: string;
  kind: MemberPosition["kind"];
  units: bigint;
  capitalCents: bigint;
  cashAppliedCents: bigint;
};

/**
 * Folds COMPLETED transfers effective on or before `throughOn` into
 * `positions` (pure). Transfers apply in `compareTransfers` order. For each,
 * `before(t)` gives the receipt-only positions immediately before it (as of
 * its `effectiveOn`, same-day receipts recorded before its completion); the
 * transferor's balances then are those plus the earlier transfers' moves.
 * With `N` its units then and `n` the transferred units (micro-units):
 * `n` units move exactly; `capitalCents` and `cashAppliedCents` move by
 * `roundDiv(x × n, N)` (the rounding of ECONOMICS R39). Committed,
 * pending, held and the outstanding Balance stay with the transferor
 * (Section 7.9.2). The transferee gets a zero row when it has none.
 * `N = 0`, `n > N` or a negative result throws (data integrity).
 */
export function foldTransfers(
  positions: MemberPosition[],
  transfers: FoldTransfer[],
  before: (t: FoldTransfer) => MemberPosition[],
  throughOn: string,
): MemberPosition[] {
  const ordered = transfers
    .filter((t) => t.effectiveOn <= throughOn)
    .sort(compareTransfers);
  if (ordered.length === 0) return positions;

  const deltas = new Map<string, Delta>();
  const deltaOf = (
    stakeholderId: string,
    unitClassId: string,
    kind: MemberPosition["kind"],
  ): Delta => {
    const key = keyOf(stakeholderId, unitClassId);
    let d = deltas.get(key);
    if (!d) {
      d = {
        stakeholderId,
        unitClassId,
        kind,
        units: 0n,
        capitalCents: 0n,
        cashAppliedCents: 0n,
      };
      deltas.set(key, d);
    }
    return d;
  };

  for (const t of ordered) {
    const base = before(t).find(
      (p) =>
        p.stakeholderId === t.fromStakeholderId &&
        p.unitClassId === t.unitClassId,
    );
    const prior = deltas.get(keyOf(t.fromStakeholderId, t.unitClassId));
    const kind = base?.kind ?? prior?.kind;
    const held =
      (base ? microUnitsFromDecimal(base.units) : 0n) + (prior?.units ?? 0n);
    const n = microUnitsFromDecimal(t.units);
    if (kind === undefined || held <= 0n || n <= 0n || n > held) {
      throw new Error(
        `Unit transfer ${t.id} moves ${microUnitsToDecimalString(n)} units effective ${t.effectiveOn}, but the transferor holds ${microUnitsToDecimalString(held)} then (ledger data integrity).`,
      );
    }
    const capital = (base?.capitalCents ?? 0n) + (prior?.capitalCents ?? 0n);
    const cash =
      (base?.cashAppliedCents ?? 0n) + (prior?.cashAppliedCents ?? 0n);
    const movedCapital = roundDiv(capital * n, held);
    const movedCash = roundDiv(cash * n, held);
    const from = deltaOf(t.fromStakeholderId, t.unitClassId, kind);
    const to = deltaOf(t.toStakeholderId, t.unitClassId, kind);
    from.units -= n;
    from.capitalCents -= movedCapital;
    from.cashAppliedCents -= movedCash;
    to.units += n;
    to.capitalCents += movedCapital;
    to.cashAppliedCents += movedCash;
  }

  const rows = new Map(
    positions.map((p) => [keyOf(p.stakeholderId, p.unitClassId), p]),
  );
  for (const [key, d] of deltas) {
    const row: MemberPosition = rows.get(key) ?? {
      stakeholderId: d.stakeholderId,
      unitClassId: d.unitClassId,
      kind: d.kind,
      committedCents: 0n,
      pendingCommittedCents: 0n,
      heldCents: 0n,
      cashAppliedCents: 0n,
      capitalCents: 0n,
      units: microUnitsToDecimalString(0n),
      outstandingBalanceCents: 0n,
      firstAcceptedOn: null,
    };
    const units = microUnitsFromDecimal(row.units) + d.units;
    if (units < 0n) {
      throw new Error(
        `Unit transfers leave stakeholder ${d.stakeholderId} with negative units (ledger data integrity).`,
      );
    }
    rows.set(key, {
      ...row,
      units: microUnitsToDecimalString(units),
      capitalCents: row.capitalCents + d.capitalCents,
      cashAppliedCents: row.cashAppliedCents + d.cashAppliedCents,
    });
  }
  return [...rows.values()].sort((a, b) => {
    if (a.stakeholderId !== b.stakeholderId)
      return a.stakeholderId < b.stakeholderId ? -1 : 1;
    if (a.unitClassId !== b.unitClassId)
      return a.unitClassId < b.unitClassId ? -1 : 1;
    return 0;
  });
}

/** Class-level sums of `getMemberPositions`. */
export async function getClassTotals(
  db: TPrismaOrTransaction,
  companyId: string,
  unitClassId: string,
  opts?: { asOf?: string },
): Promise<ClassTotals> {
  const positions = await getMemberPositions(db, companyId, {
    asOf: opts?.asOf,
    unitClassId,
  });
  return sumPositions(positions);
}
