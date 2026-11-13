import "server-only";
import type { Ymd } from "@/lib/governance/dates";
import type { UnitPosition } from "@/lib/governance/resolution-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { getSuspendedUnits } from "@/server/llc/economics/suspension";
import { getMemberPositions } from "@/server/llc/positions";

// The ONLY place governance reads units (03-governance.md G6). Units come
// from FOUNDATION `getMemberPositions` (asOf inclusive); suspension comes from
// ECONOMICS `getSuspendedUnits` (declared, uncured default with dueOn < asOf).

export interface UndeclaredOverdueWarning {
  stakeholderId: string;
  callNoticeLineId: string;
  dueOn: Ymd;
  /** Integer cents still outstanding (JS number for the wire). */
  outstandingCents: number;
}

/**
 * Positions plus the ECONOMICS warnings for overdue Balance lines with no
 * declared default (their units still vote, Section 4.9). `resolution.preview`
 * turns each warning into "{name} has an overdue Balance but no declared
 * default; its units still vote (Section 4.9)."
 */
export async function loadUnitPositionsWithWarnings(
  tx: TPrismaOrTransaction,
  companyId: string,
  asOf: Ymd,
): Promise<{
  positions: UnitPosition[];
  warnings: UndeclaredOverdueWarning[];
}> {
  const rows = await getMemberPositions(tx, companyId, { asOf });
  const { suspended, undeclaredOverdue } = await getSuspendedUnits(
    tx,
    companyId,
    asOf,
  );
  const suspendedIds = new Set(suspended.map((s) => s.stakeholderId));

  const positions: UnitPosition[] = rows.map((row) => {
    if (row.kind !== "PREFERRED" && row.kind !== "COMMON") {
      throw new Error(`Unknown unit class kind ${String(row.kind)}`);
    }
    return {
      stakeholderId: row.stakeholderId,
      unitClassId: row.unitClassId,
      unitClassKind: row.kind,
      units: row.units,
      suspended:
        row.kind === "PREFERRED" && suspendedIds.has(row.stakeholderId),
    };
  });

  const warnings: UndeclaredOverdueWarning[] = undeclaredOverdue.map((w) => ({
    stakeholderId: w.stakeholderId,
    callNoticeLineId: w.callNoticeLineId,
    dueOn: w.dueOn,
    outstandingCents: Number(w.outstanding),
  }));

  return { positions, warnings };
}

/** One `UnitPosition` per (stakeholder, unit class) as of `asOf` (inclusive). */
export async function loadUnitPositions(
  tx: TPrismaOrTransaction,
  companyId: string,
  asOf: Ymd,
): Promise<UnitPosition[]> {
  const { positions } = await loadUnitPositionsWithWarnings(
    tx,
    companyId,
    asOf,
  );
  return positions;
}
