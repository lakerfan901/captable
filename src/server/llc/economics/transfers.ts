import "server-only";

import { toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import {
  type MicroUnits,
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import type { TPrismaOrTransaction } from "@/server/db";
import { getMemberPositions } from "@/server/llc/positions";
import { trimUnits, unitsToWire } from "@/server/llc/serialize";
import { ruleViolation } from "./scope";
import { assertLedgerDateOpen } from "./term";

type Tx = TPrismaOrTransaction;

/** COMPLETED Preferred transfers (GOVERNANCE `UnitTransfer`), oldest first. Read only; R39. */
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
    orderBy: [{ effectiveOn: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      effectiveOn: true,
      fromStakeholderId: true,
      toStakeholderId: true,
      units: true,
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
      createdAt: r.createdAt,
    });
  }
  return out;
}

/**
 * Validation only (GOVERNANCE calls it inside the transaction that completes
 * the transfer): economics stores nothing for a transfer. Throws BAD_REQUEST
 * when `effectiveOn` is before a finalized distribution's payment date or the
 * transferor holds fewer than `units` of the class as of `effectiveOn`.
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
