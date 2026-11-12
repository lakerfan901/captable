import {
  type ClassTotals,
  type MemberPosition,
  mergePositions,
  sumPositions,
} from "@/lib/admission/positions-merge";
import { fromDateOnly } from "@/lib/date-only";
import type { TPrismaOrTransaction } from "@/server/db";
import { dateToWire, unitsToWire } from "@/server/llc/serialize";

export type { ClassTotals, MemberPosition };

/**
 * Holdings per (stakeholder, unit class), computed from non-void receipts.
 * This is the only place that sums units (B20). With `asOf` (inclusive),
 * only commitments accepted on or before it and receipts applied on or
 * before it count.
 */
export async function getMemberPositions(
  db: TPrismaOrTransaction,
  companyId: string,
  opts?: { asOf?: string; unitClassId?: string },
): Promise<MemberPosition[]> {
  const asOf = opts?.asOf;
  const asOfDate = asOf === undefined ? undefined : fromDateOnly(asOf);
  const classFilter = opts?.unitClassId
    ? { unitClassId: opts.unitClassId }
    : {};

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
        ...(asOfDate ? { appliedOn: { lte: asOfDate } } : {}),
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
