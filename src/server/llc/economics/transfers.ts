import "server-only";

import { toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import {
  type MicroUnits,
  microUnitsFromDecimal,
  microUnitsToDecimalString,
  roundDiv,
} from "@/lib/llc/money";
import { computePositions } from "@/lib/llc/positions";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  getMemberPositions,
  getTransferMoves,
  TransferIntegrityError,
} from "@/server/llc/positions";
import { trimUnits, unitsToWire } from "@/server/llc/serialize";
import { getPositions } from "./ledger";
import { ruleViolation } from "./scope";
import { assertBooksOpen, assertLedgerDateOpen } from "./term";

type Tx = TPrismaOrTransaction;

/**
 * COMPLETED Preferred transfers (GOVERNANCE `UnitTransfer`), oldest first.
 * Read only; R39. `createdAt` carries the completion time (`completedAt`,
 * else `createdAt`): `assignSeq` orders same-day events by it, so transfers
 * apply in the order of FOUNDATION's `getMemberPositions` fold-in
 * (`effectiveOn`, completion time, id).
 */
export async function loadCompletedTransfers(
  tx: Tx,
  companyId: string,
): Promise<
  {
    id: string;
    effectiveOn: IsoDate;
    fromStakeholderId: string;
    toStakeholderId: string;
    units: MicroUnits;
    createdAt: Date;
  }[]
> {
  const rows = await tx.unitTransfer.findMany({
    where: {
      companyId,
      status: "COMPLETED",
      unitClassKind: "PREFERRED",
      effectiveOn: { not: null },
      toStakeholderId: { not: null },
    },
    orderBy: [{ effectiveOn: "asc" }, { completedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      effectiveOn: true,
      fromStakeholderId: true,
      toStakeholderId: true,
      units: true,
      completedAt: true,
      createdAt: true,
    },
  });
  const out = [];
  for (const r of rows) {
    // Both are filtered to non-null above.
    if (r.effectiveOn === null || r.toStakeholderId === null) continue;
    out.push({
      id: r.id,
      effectiveOn: toDateOnly(r.effectiveOn),
      fromStakeholderId: r.fromStakeholderId,
      toStakeholderId: r.toStakeholderId,
      units: microUnitsFromDecimal(unitsToWire(r.units)),
      createdAt: r.completedAt ?? r.createdAt,
    });
  }
  return out;
}

/**
 * Validation only (GOVERNANCE calls it inside the transaction that completes
 * the transfer): economics stores nothing for a transfer. Throws BAD_REQUEST
 * when `effectiveOn` is on or before a finalized distribution's payment date
 * or inside closed books, or the transferor holds fewer than `units` of the
 * class as of `effectiveOn`.
 */
export async function applyUnitTransfer(
  tx: Tx,
  input: {
    companyId: string;
    unitTransferId: string;
    fromStakeholderId: string;
    toStakeholderId: string;
    unitClassId: string;
    units: string;
    effectiveOn: Date;
  },
): Promise<void> {
  const effectiveOn = toDateOnly(input.effectiveOn);
  await assertLedgerDateOpen(tx, input.companyId, effectiveOn);
  const term = await tx.llcTerm.findUnique({
    where: { companyId: input.companyId },
  });
  if (term) assertBooksOpen(term, effectiveOn);
  const requested = microUnitsFromDecimal(input.units);
  if (requested <= 0n) {
    ruleViolation("A transfer must move more than zero units (Section 7).");
  }
  const positions = await getMemberPositions(tx, input.companyId, {
    asOf: effectiveOn,
    unitClassId: input.unitClassId,
  });
  let held = 0n;
  for (const row of positions) {
    if (row.stakeholderId === input.fromStakeholderId) {
      held += microUnitsFromDecimal(row.units);
    }
  }
  if (held < requested) {
    ruleViolation(
      `The transferor holds ${trimUnits(microUnitsToDecimalString(held))} units on ${effectiveOn}, fewer than the ${trimUnits(microUnitsToDecimalString(requested))} being transferred (Section 7).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Completed transfers must not be stranded by later ledger writes (G16b).

interface MoveFigures {
  transferId: string;
  fromStakeholderId: string;
  toStakeholderId: string;
  units: string;
  effectiveOn: IsoDate;
  capitalCents: bigint;
  cashAppliedCents: bigint;
  /** ECONOMICS Unreturned Capital moved (Preferred transfers only). */
  unreturnedCents: bigint | null;
}

const byEffectiveCompletedId = (
  a: { effectiveOn: IsoDate; createdAt: Date; id: string },
  b: { effectiveOn: IsoDate; createdAt: Date; id: string },
): number => {
  if (a.effectiveOn !== b.effectiveOn) {
    return a.effectiveOn < b.effectiveOn ? -1 : 1;
  }
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Per COMPLETED transfer, what it moves: units, capital and cash applied
 * from FOUNDATION's fold-in, and for Preferred transfers the Unreturned
 * Capital the ECONOMICS engine moves (`roundDiv(unreturned × n, N)` on the
 * transferor's position just before the TRANSFER event). Also runs
 * ECONOMICS' FOUNDATION cross-check through the latest effective date.
 */
async function loadMoveFigures(
  tx: Tx,
  companyId: string,
): Promise<MoveFigures[]> {
  const moves = await getTransferMoves(tx, companyId);
  if (moves.length === 0) return [];
  const out = new Map<string, MoveFigures>();
  let latest = "";
  for (const m of moves) {
    const t = m.transfer;
    if (t.effectiveOn > latest) latest = t.effectiveOn;
    out.set(t.id, {
      transferId: t.id,
      fromStakeholderId: t.fromStakeholderId,
      toStakeholderId: t.toStakeholderId,
      units: t.units,
      effectiveOn: t.effectiveOn,
      capitalCents: m.capitalCents,
      cashAppliedCents: m.cashAppliedCents,
      unreturnedCents: null,
    });
  }
  const preferred = (await loadCompletedTransfers(tx, companyId)).sort(
    byEffectiveCompletedId,
  );
  if (preferred.length === 0) return [...out.values()];
  const { ledger, config } = await getPositions(tx, companyId, latest);
  // assignSeq orders same-day transfers by completion time, then id: the
  // order of `preferred`.
  const events = ledger.events
    .filter((e) => e.kind === "TRANSFER")
    .sort((a, b) => a.seq - b.seq);
  if (events.length !== preferred.length) {
    throw new Error("Transfer events do not match the completed transfers.");
  }
  for (const [i, e] of events.entries()) {
    const t = preferred[i];
    if (
      e.kind !== "TRANSFER" ||
      t === undefined ||
      e.on !== t.effectiveOn ||
      e.fromHolderId !== t.fromStakeholderId ||
      e.toHolderId !== t.toStakeholderId ||
      e.units !== t.units
    ) {
      throw new Error("Transfer events do not match the completed transfers.");
    }
    const from = computePositions(ledger.events, e.on, config, {
      untilSeq: e.seq,
    }).holders.get(e.fromHolderId);
    const figures = out.get(t.id);
    if (!from || from.preferredUnits <= 0n || !figures) continue;
    figures.unreturnedCents = roundDiv(
      from.unreturned * e.units,
      from.preferredUnits,
    );
  }
  return [...out.values()];
}

/**
 * Taken inside a ledger write's transaction, after its locks and before the
 * write; `check()` after the write refuses (BAD_REQUEST, Section 7.9.1) when
 * the write leaves a completed transfer without its units, or lowers the
 * capital, cash applied or Unreturned Capital it moved. Null (one query,
 * nothing else) when the company has no completed transfer. A ledger
 * already inconsistent before the write is not judged.
 */
export async function guardCompletedTransfers(
  tx: Tx,
  companyId: string,
): Promise<{ check: () => Promise<void> } | null> {
  const any = await tx.unitTransfer.findFirst({
    where: { companyId, status: "COMPLETED" },
    select: { id: true },
  });
  if (!any) return null;
  let before: MoveFigures[];
  try {
    before = await loadMoveFigures(tx, companyId);
  } catch (error) {
    if (error instanceof TransferIntegrityError) return null;
    throw error;
  }
  return {
    check: async () => {
      let after: MoveFigures[];
      try {
        after = await loadMoveFigures(tx, companyId);
      } catch (error) {
        if (!(error instanceof TransferIntegrityError)) throw error;
        const failed = before.find((b) => b.transferId === error.transfer?.id);
        return await refuseStranding(tx, companyId, failed, "units");
      }
      const byId = new Map(after.map((a) => [a.transferId, a]));
      for (const b of before) {
        const a = byId.get(b.transferId);
        if (!a) return await refuseStranding(tx, companyId, b, "units");
        if (
          a.capitalCents < b.capitalCents ||
          a.cashAppliedCents < b.cashAppliedCents
        ) {
          return await refuseStranding(tx, companyId, b, "capital");
        }
        if (
          b.unreturnedCents !== null &&
          (a.unreturnedCents ?? 0n) < b.unreturnedCents
        ) {
          return await refuseStranding(tx, companyId, b, "unreturned");
        }
      }
    },
  };
}

async function refuseStranding(
  tx: Tx,
  companyId: string,
  m: MoveFigures | undefined,
  what: "units" | "capital" | "unreturned",
): Promise<never> {
  if (!m) {
    ruleViolation(
      "This would leave a completed unit transfer without the units it moved (Section 7.9.1). A completed transfer cannot be changed afterwards; ask an administrator to correct the ledger.",
    );
  }
  const rows = await tx.stakeholder.findMany({
    where: { companyId, id: { in: [m.fromStakeholderId, m.toStakeholderId] } },
    select: { id: true, name: true },
  });
  const name = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
  const units = trimUnits(m.units);
  const subject =
    what === "units"
      ? `the ${units} units`
      : what === "capital"
        ? `the capital of the ${units} units`
        : `the Unreturned Capital Contributions of the ${units} units`;
  ruleViolation(
    `This would leave ${name(m.fromStakeholderId)} without ${subject} transferred to ${name(m.toStakeholderId)} effective ${m.effectiveOn} (Section 7.9.1). A completed transfer cannot be changed afterwards; record the correction dated after ${m.effectiveOn}, or ask an administrator to correct the ledger.`,
  );
}
