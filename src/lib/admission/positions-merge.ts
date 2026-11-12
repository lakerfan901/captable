/**
 * In-memory merge behind `getMemberPositions` (src/server/llc/positions.ts).
 * Pure: the caller loads commitment rows and per-commitment receipt sums
 * (non-void receipts only; already filtered by `appliedOn <= asOf` when an
 * `asOf` is given) and this module turns them into one position per
 * (stakeholder, unit class). Money is bigint cents, units are bigint
 * micro-units internally and 6-dp strings in the result.
 */
import { microUnitsFromDecimal, microUnitsToDecimalString } from "../llc/money";
import {
  type CommitmentStatus,
  outstandingBalanceCents,
  type ReceiptKind,
} from "./commitment-rules";

export type UnitClassKind = "PREFERRED" | "COMMON";

export type CommitmentRow = {
  id: string;
  stakeholderId: string;
  unitClassId: string;
  classKind: UnitClassKind;
  status: CommitmentStatus;
  committedCents: bigint;
  acceptedCents: bigint;
  /** `YYYY-MM-DD`; also set on REJECTED (decision date). */
  acceptedOn: string | null;
};

/** Sums of non-void receipts of one commitment and one kind. */
export type ReceiptGroup = {
  commitmentId: string;
  kind: ReceiptKind;
  amountCents: bigint;
  appliedCents: bigint;
  /** 6-dp string (e.g. Prisma Decimal `.toFixed(6)`). */
  units: string;
};

export type MemberPosition = {
  stakeholderId: string;
  unitClassId: string;
  kind: UnitClassKind;
  committedCents: bigint;
  pendingCommittedCents: bigint;
  heldCents: bigint;
  cashAppliedCents: bigint;
  capitalCents: bigint;
  units: string;
  outstandingBalanceCents: bigint;
  firstAcceptedOn: string | null;
};

export type ClassTotals = {
  committedCents: bigint;
  pendingCommittedCents: bigint;
  cashAppliedCents: bigint;
  capitalCents: bigint;
  units: string;
  outstandingBalanceCents: bigint;
};

const CASH_KINDS: ReadonlySet<ReceiptKind> = new Set([
  "INITIAL",
  "BALANCE",
  "REPLACEMENT",
]);

type Acc = {
  stakeholderId: string;
  unitClassId: string;
  kind: UnitClassKind;
  hasCommitment: boolean;
  committedCents: bigint;
  pendingCommittedCents: bigint;
  heldCents: bigint;
  cashAppliedCents: bigint;
  capitalCents: bigint;
  microUnits: bigint;
  firstAcceptedOn: string | null;
};

const keyOf = (stakeholderId: string, unitClassId: string) =>
  `${stakeholderId}\u0000${unitClassId}`;

/**
 * One row per (stakeholder, class) that has a commitment in scope or an
 * applied receipt in scope. With `asOf`, only commitments with
 * `acceptedOn <= asOf` that are ACCEPTED/REDUCED count (PENDING has no
 * acceptance date; a REJECTED commitment never counts); receipts are
 * expected to be pre-filtered by `appliedOn <= asOf`.
 */
export function mergePositions(
  commitments: CommitmentRow[],
  receiptGroups: ReceiptGroup[],
  opts?: { asOf?: string },
): MemberPosition[] {
  const asOf = opts?.asOf;
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const acc = new Map<string, Acc>();

  const slot = (c: CommitmentRow): Acc => {
    const key = keyOf(c.stakeholderId, c.unitClassId);
    let row = acc.get(key);
    if (!row) {
      row = {
        stakeholderId: c.stakeholderId,
        unitClassId: c.unitClassId,
        kind: c.classKind,
        hasCommitment: false,
        committedCents: 0n,
        pendingCommittedCents: 0n,
        heldCents: 0n,
        cashAppliedCents: 0n,
        capitalCents: 0n,
        microUnits: 0n,
        firstAcceptedOn: null,
      };
      acc.set(key, row);
    }
    return row;
  };

  const inScope = (c: CommitmentRow): boolean => {
    if (asOf === undefined) return true;
    if (c.status !== "ACCEPTED" && c.status !== "REDUCED") return false;
    return c.acceptedOn !== null && c.acceptedOn <= asOf;
  };

  for (const c of commitments) {
    if (!inScope(c)) continue;
    const row = slot(c);
    row.hasCommitment = true;
    if (c.status === "ACCEPTED" || c.status === "REDUCED") {
      row.committedCents += c.acceptedCents;
      if (
        c.acceptedOn !== null &&
        (row.firstAcceptedOn === null || c.acceptedOn < row.firstAcceptedOn)
      ) {
        row.firstAcceptedOn = c.acceptedOn;
      }
    } else if (c.status === "PENDING") {
      row.pendingCommittedCents += c.committedCents;
    }
  }

  for (const g of receiptGroups) {
    const c = byId.get(g.commitmentId);
    if (!c) {
      throw new Error(
        `Receipt group references commitment ${g.commitmentId}, which was not loaded.`,
      );
    }
    const row = slot(c);
    if (c.status === "PENDING") {
      row.heldCents += g.amountCents;
    }
    if (CASH_KINDS.has(g.kind)) {
      row.cashAppliedCents += g.appliedCents;
    }
    row.capitalCents += g.appliedCents;
    row.microUnits += microUnitsFromDecimal(g.units);
  }

  return [...acc.values()]
    .filter(
      (r) =>
        r.hasCommitment ||
        r.capitalCents !== 0n ||
        r.microUnits !== 0n ||
        r.heldCents !== 0n,
    )
    .map(
      (r): MemberPosition => ({
        stakeholderId: r.stakeholderId,
        unitClassId: r.unitClassId,
        kind: r.kind,
        committedCents: r.committedCents,
        pendingCommittedCents: r.pendingCommittedCents,
        heldCents: r.heldCents,
        cashAppliedCents: r.cashAppliedCents,
        capitalCents: r.capitalCents,
        units: microUnitsToDecimalString(r.microUnits),
        outstandingBalanceCents: outstandingBalanceCents(
          r.committedCents,
          r.cashAppliedCents,
        ),
        firstAcceptedOn: r.firstAcceptedOn,
      }),
    )
    .sort((a, b) => {
      if (a.stakeholderId !== b.stakeholderId)
        return a.stakeholderId < b.stakeholderId ? -1 : 1;
      if (a.unitClassId !== b.unitClassId)
        return a.unitClassId < b.unitClassId ? -1 : 1;
      return 0;
    });
}

/** Sums of positions (normally of one class). */
export function sumPositions(positions: MemberPosition[]): ClassTotals {
  let committedCents = 0n;
  let pendingCommittedCents = 0n;
  let cashAppliedCents = 0n;
  let capitalCents = 0n;
  let microUnits = 0n;
  let outstanding = 0n;
  for (const p of positions) {
    committedCents += p.committedCents;
    pendingCommittedCents += p.pendingCommittedCents;
    cashAppliedCents += p.cashAppliedCents;
    capitalCents += p.capitalCents;
    microUnits += microUnitsFromDecimal(p.units);
    outstanding += p.outstandingBalanceCents;
  }
  return {
    committedCents,
    pendingCommittedCents,
    cashAppliedCents,
    capitalCents,
    units: microUnitsToDecimalString(microUnits),
    outstandingBalanceCents: outstanding,
  };
}
