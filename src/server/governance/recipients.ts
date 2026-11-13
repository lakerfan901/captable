import "server-only";
import type { Ymd } from "@/lib/governance/dates";
import { fromMicro, toMicro } from "@/lib/llc/voting";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadUnitPositions } from "./positions";

export interface CurrentMember {
  stakeholderId: string;
  name: string;
  /** noticeEmail ?? email */
  email: string;
  preferredUnits: string;
  commonUnits: string;
}

/**
 * R22: admitted Members (memberStatus MEMBER) holding units > 0 as of
 * `today` (inclusive). Suspended Members are included (they still receive
 * reports and notices). Sorted by name.
 */
export async function listCurrentMembers(
  tx: TPrismaOrTransaction,
  companyId: string,
  today: Ymd,
): Promise<CurrentMember[]> {
  const stakeholders = await tx.stakeholder.findMany({
    where: { companyId, memberStatus: "MEMBER" },
    select: { id: true, name: true, email: true, noticeEmail: true },
  });
  const positions = await loadUnitPositions(tx, companyId, today);

  const units = new Map<string, { preferred: bigint; common: bigint }>();
  for (const p of positions) {
    const row = units.get(p.stakeholderId) ?? { preferred: 0n, common: 0n };
    if (p.unitClassKind === "PREFERRED") row.preferred += toMicro(p.units);
    else row.common += toMicro(p.units);
    units.set(p.stakeholderId, row);
  }

  const out: CurrentMember[] = [];
  for (const s of stakeholders) {
    const u = units.get(s.id);
    if (!u || u.preferred + u.common <= 0n) continue;
    out.push({
      stakeholderId: s.id,
      name: s.name,
      email: s.noticeEmail ?? s.email,
      preferredUnits: fromMicro(u.preferred),
      commonUnits: fromMicro(u.common),
    });
  }
  out.sort((a, b) => {
    const n = a.name.localeCompare(b.name, "en");
    if (n !== 0) return n;
    return a.stakeholderId < b.stakeholderId ? -1 : 1;
  });
  return out;
}

export interface ManagerUser {
  memberId: string;
  name: string | null;
  email: string;
}

/** ACTIVE ADMIN team users of the company that have an email address. */
export async function listManagerUsers(
  tx: TPrismaOrTransaction,
  companyId: string,
): Promise<ManagerUser[]> {
  const rows = await tx.member.findMany({
    where: { companyId, status: "ACTIVE", role: "ADMIN" },
    select: { id: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const out: ManagerUser[] = [];
  for (const r of rows) {
    const email = r.user.email?.trim();
    if (!email) continue;
    out.push({ memberId: r.id, name: r.user.name, email });
  }
  return out;
}
