import "server-only";

import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import { isSuspended } from "@/lib/llc/default";
import {
  type Cents,
  type MicroUnits,
  microUnitsFromDecimal,
} from "@/lib/llc/money";
import type { TPrismaOrTransaction } from "@/server/db";
import { getMemberPositions } from "@/server/llc/positions";

/**
 * R32 (§4.9(iii), §1.23): Preferred Units suspended from votes on `asOf`.
 * `suspended`: declared, non-voided, uncured defaults with dueOn < asOf; units
 * from FOUNDATION's `getMemberPositions` (works before the price per unit is
 * set). `undeclaredOverdue`: SENT Call Notice lines past due with no
 * `MemberDefault` and money still outstanding — a warning only.
 */
export async function getSuspendedUnits(
  tx: TPrismaOrTransaction,
  companyId: string,
  asOf: IsoDate,
): Promise<{
  suspended: {
    stakeholderId: string;
    preferredUnits: MicroUnits;
    memberDefaultIds: string[];
  }[];
  undeclaredOverdue: {
    stakeholderId: string;
    callNoticeLineId: string;
    dueOn: IsoDate;
    outstanding: Cents;
  }[];
}> {
  const defaults = await tx.memberDefault.findMany({
    where: { companyId, status: { not: "VOIDED" } },
    select: {
      id: true,
      stakeholderId: true,
      status: true,
      dueOn: true,
      curedOn: true,
    },
    orderBy: [{ dueOn: "asc" }, { id: "asc" }],
  });
  const defaultIds = new Map<string, string[]>();
  for (const d of defaults) {
    const active = isSuspended(
      {
        status: d.status,
        dueOn: toDateOnly(d.dueOn),
        curedOn: d.curedOn === null ? null : toDateOnly(d.curedOn),
      },
      asOf,
    );
    if (!active) continue;
    const ids = defaultIds.get(d.stakeholderId) ?? [];
    ids.push(d.id);
    defaultIds.set(d.stakeholderId, ids);
  }

  const suspended: {
    stakeholderId: string;
    preferredUnits: MicroUnits;
    memberDefaultIds: string[];
  }[] = [];
  if (defaultIds.size > 0) {
    const units = new Map<string, MicroUnits>();
    for (const row of await getMemberPositions(tx, companyId, { asOf })) {
      if (row.kind !== "PREFERRED") continue;
      units.set(
        row.stakeholderId,
        (units.get(row.stakeholderId) ?? 0n) + microUnitsFromDecimal(row.units),
      );
    }
    for (const [stakeholderId, memberDefaultIds] of defaultIds) {
      suspended.push({
        stakeholderId,
        preferredUnits: units.get(stakeholderId) ?? 0n,
        memberDefaultIds,
      });
    }
    suspended.sort((a, b) =>
      a.stakeholderId < b.stakeholderId
        ? -1
        : a.stakeholderId > b.stakeholderId
          ? 1
          : 0,
    );
  }

  const lines = await tx.callNoticeLine.findMany({
    where: {
      companyId,
      status: "SENT",
      dueOn: { lt: fromDateOnly(asOf) },
      memberDefault: { is: null },
    },
    select: {
      id: true,
      stakeholderId: true,
      dueOn: true,
      amountCalledCents: true,
    },
    orderBy: [{ dueOn: "asc" }, { id: "asc" }],
  });
  const undeclaredOverdue: {
    stakeholderId: string;
    callNoticeLineId: string;
    dueOn: IsoDate;
    outstanding: Cents;
  }[] = [];
  if (lines.length > 0) {
    const paid = await tx.callNoticeAllocation.groupBy({
      by: ["callNoticeLineId"],
      where: { companyId, callNoticeLineId: { in: lines.map((l) => l.id) } },
      _sum: { amountCents: true },
    });
    const paidByLine = new Map(
      paid.map((p) => [p.callNoticeLineId, p._sum.amountCents ?? 0n]),
    );
    for (const line of lines) {
      if (line.dueOn === null) continue;
      const outstanding =
        line.amountCalledCents - (paidByLine.get(line.id) ?? 0n);
      if (outstanding <= 0n) continue;
      undeclaredOverdue.push({
        stakeholderId: line.stakeholderId,
        callNoticeLineId: line.id,
        dueOn: toDateOnly(line.dueOn),
        outstanding,
      });
    }
  }

  return { suspended, undeclaredOverdue };
}
