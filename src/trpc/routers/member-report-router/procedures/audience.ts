import "server-only";
import type { Ymd } from "@/lib/governance/dates";
import { TRANSFER_NOTICE_KINDS } from "@/lib/governance/report-figures";
import { fromMicro, toMicro } from "@/lib/llc/voting";
import { describeAccess } from "@/lib/portal/access-admin-core";
import {
  type AudienceHolder,
  type AudiencePresets,
  audiencePresets,
  type HolderMemberStatus,
  type HolderPortalState,
  isCurrentMember,
  isTransferNotice,
  type ReportType,
} from "@/lib/portal/audience-core";
import { normalizePortalEmail } from "@/lib/portal/visibility-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadUnitPositions } from "@/server/governance/positions";
import { listCurrentMembers } from "@/server/governance/recipients";

// Who receives a member report.
//
// Since the investor portal (04-investor-portal.md P18, package P4a) the
// audience of a release is the list of holders the Manager user confirmed;
// `loadAudienceHolders` builds every holder of the company with the facts
// the pure checks of `@/lib/portal/audience-core` need (status, units, K-1,
// notice address, portal state), and the presets that fill the picker.
// The rule-based audience below (`deriveAudience`, 03-governance.md G12 send
// step 2; R22, R22a) is the DEFAULT of that picker: the legacy
// `memberReport.send` entry point releases to exactly it, and `get` lists it
// as the draft's candidates. The two agree (asserted by
// release.integration.ts):
//
// - QUARTERLY / ANNUAL / NOTICE: the current Members (`memberStatus MEMBER`
//   with units > 0, suspended Members included). A Financial-Interest-only
//   holder is NEVER one of them.
// - Transfer notices (7.1, 7.2): only the OTHER Preferred Members (Preferred
//   units > 0, not the transferring Member).
// - TAX_K1: exactly the holders a K-1 is attached for (Members and
//   Financial-Interest-only holders; never a PROSPECT).

export interface AudienceMember {
  stakeholderId: string;
  name: string;
  /** noticeEmail ?? email, trimmed ("" when missing) */
  email: string;
}

export type Audience =
  | { ok: true; members: AudienceMember[] }
  | { ok: false; problem: string };

export async function deriveAudience(
  tx: TPrismaOrTransaction,
  companyId: string,
  report: { id: string; type: string; noticeKind: string | null },
  today: Ymd,
): Promise<Audience> {
  if (report.type === "TAX_K1") {
    return { ok: true, members: await k1Holders(tx, companyId, report.id) };
  }

  const current = await listCurrentMembers(tx, companyId, today);
  if (
    report.type === "NOTICE" &&
    (TRANSFER_NOTICE_KINDS as readonly string[]).includes(
      report.noticeKind ?? "",
    )
  ) {
    const transfer = await tx.unitTransfer.findFirst({
      where: { companyId, noticeCopyReportId: report.id },
      select: { fromStakeholderId: true },
    });
    if (!transfer) {
      return { ok: false, problem: "This notice is not linked to a transfer." };
    }
    return {
      ok: true,
      members: current
        .filter(
          (m) =>
            toMicro(m.preferredUnits) > 0n &&
            m.stakeholderId !== transfer.fromStakeholderId,
        )
        .map(toAudience),
    };
  }
  return { ok: true, members: current.map(toAudience) };
}

function toAudience(m: {
  stakeholderId: string;
  name: string;
  email: string;
}): AudienceMember {
  return {
    stakeholderId: m.stakeholderId,
    name: m.name,
    email: m.email.trim(),
  };
}

/** R22a: the distinct holders of this report's K-1 attachments, PROSPECTs excluded. */
export async function k1Holders(
  tx: TPrismaOrTransaction,
  companyId: string,
  reportId: string,
): Promise<AudienceMember[]> {
  const attachments = await tx.memberReportAttachment.findMany({
    where: { reportId, companyId, kind: "K1", stakeholderId: { not: null } },
    select: { stakeholderId: true },
  });
  const ids = [
    ...new Set(
      attachments.flatMap((a) => (a.stakeholderId ? [a.stakeholderId] : [])),
    ),
  ];
  if (ids.length === 0) return [];
  const holders = await tx.stakeholder.findMany({
    where: {
      id: { in: ids },
      companyId,
      memberStatus: { in: ["MEMBER", "FINANCIAL_INTEREST_ONLY"] },
    },
    select: { id: true, name: true, email: true, noticeEmail: true },
  });
  return holders
    .map((h) => ({
      stakeholderId: h.id,
      name: h.name,
      email: (h.noticeEmail ?? h.email).trim(),
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        (a.stakeholderId < b.stakeholderId ? -1 : 1),
    );
}

/**
 * Portal state per holder (holders without an entry: "NONE"), by the rule
 * of the member page's "Portal access" card (`describeAccess`, package P3),
 * so both screens agree: ACTIVE when one ACTIVE access of the holder has
 * been set up (a password set at or after THIS access was invited, or the
 * holder opened in the portal), INVITED when its ACTIVE accesses are not
 * set up yet. DISABLED accesses do not count. Only facts of this company's
 * access rows are read: a password the person set for another company does
 * not make the holder ACTIVE here, so nothing about other companies shows.
 */
export async function loadPortalStates(
  tx: TPrismaOrTransaction,
  companyId: string,
  stakeholderIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, HolderPortalState>> {
  const out = new Map<string, HolderPortalState>();
  if (stakeholderIds.length === 0) return out;
  const accesses = await tx.portalAccess.findMany({
    where: {
      companyId,
      stakeholderId: { in: [...stakeholderIds] },
      status: "ACTIVE",
    },
    select: {
      stakeholderId: true,
      status: true,
      invitedAt: true,
      lastSeenAt: true,
      portalUser: { select: { passwordSetAt: true, lockedUntil: true } },
    },
  });
  for (const a of accesses) {
    if (out.get(a.stakeholderId) === "ACTIVE") continue;
    const view = describeAccess(a, a.portalUser, now);
    if (view.state === "DISABLED") continue;
    out.set(a.stakeholderId, view.state);
  }
  return out;
}

/**
 * P27: for each holder, the access of its NOTICE ADDRESS to that holder
 * (not of anyone else, such as an accountant): "NONE" when that address was
 * never given access to the holder, else the access's status. Read through
 * this company's access rows only (by holder), so nothing is learned about
 * the address's accesses elsewhere. The release dialog lists the holders
 * whose notice address is "NONE" under "Invite these addresses".
 */
export async function loadNoticeAddressAccess(
  tx: TPrismaOrTransaction,
  companyId: string,
  holders: readonly { stakeholderId: string; noticeEmail: string }[],
): Promise<Map<string, "NONE" | "ACTIVE" | "DISABLED">> {
  const out = new Map<string, "NONE" | "ACTIVE" | "DISABLED">();
  if (holders.length === 0) return out;
  const accesses = await tx.portalAccess.findMany({
    where: {
      companyId,
      stakeholderId: { in: holders.map((h) => h.stakeholderId) },
    },
    select: {
      stakeholderId: true,
      status: true,
      portalUser: { select: { email: true } },
    },
  });
  const byHolder = new Map<string, Map<string, "ACTIVE" | "DISABLED">>();
  for (const a of accesses) {
    const m = byHolder.get(a.stakeholderId) ?? new Map();
    m.set(a.portalUser.email, a.status);
    byHolder.set(a.stakeholderId, m);
  }
  for (const h of holders) {
    const address = normalizePortalEmail(h.noticeEmail);
    out.set(
      h.stakeholderId,
      (address !== null && byHolder.get(h.stakeholderId)?.get(address)) ||
        "NONE",
    );
  }
  return out;
}

/** One holder of the company as the release checks and the picker see it. */
export interface AudienceCandidate extends AudienceHolder {
  name: string;
  /** `noticeEmail ?? email`, trimmed ("" when the holder has none). */
  noticeEmail: string;
  /** `loadPortalStates`: the member page card's rule (set up: ACTIVE; not yet: INVITED). */
  portal: HolderPortalState;
}

export interface AudienceContext {
  /** Every holder of the company (prospects included, so the checks can name them), by name. */
  holders: AudienceCandidate[];
  /** The transferring Member of a transfer notice; null otherwise or when not linked. */
  transferorId: string | null;
  presets: AudiencePresets;
  /**
   * The holders whose selection (with email) closes the report's deadline
   * (P22, `deadlineOutcome`): every current Member, or for a transfer
   * notice the other Preferred Members (the default audience).
   */
  deadlineAudienceIds: string[];
}

/**
 * P18. Every holder of the company with its status, units as of `today`
 * (the same positions as `listCurrentMembers`), whether a K-1 of THIS
 * report names it, its notice address and its portal state; the transferor
 * of a transfer notice; and the presets. Read only: `release` calls it after
 * taking the ledger, unit-class and report locks, `audienceOptions` without.
 */
export async function loadAudienceContext(
  tx: TPrismaOrTransaction,
  companyId: string,
  report: { id: string; type: string; noticeKind: string | null },
  today: Ymd,
): Promise<AudienceContext> {
  const type = report.type as ReportType;
  const transfer = isTransferNotice(type, report.noticeKind)
    ? await tx.unitTransfer.findFirst({
        where: { companyId, noticeCopyReportId: report.id },
        select: { fromStakeholderId: true },
      })
    : null;
  const stakeholders = await tx.stakeholder.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      email: true,
      noticeEmail: true,
      memberStatus: true,
    },
  });
  const positions = await loadUnitPositions(tx, companyId, today);
  const k1 = await tx.memberReportAttachment.findMany({
    where: {
      reportId: report.id,
      companyId,
      kind: "K1",
      stakeholderId: { not: null },
    },
    select: { stakeholderId: true },
  });
  const portal = await loadPortalStates(
    tx,
    companyId,
    stakeholders.map((s) => s.id),
  );

  const units = new Map<string, { preferred: bigint; common: bigint }>();
  for (const p of positions) {
    const row = units.get(p.stakeholderId) ?? { preferred: 0n, common: 0n };
    if (p.unitClassKind === "PREFERRED") row.preferred += toMicro(p.units);
    else row.common += toMicro(p.units);
    units.set(p.stakeholderId, row);
  }
  const k1For = new Set(
    k1.flatMap((a) => (a.stakeholderId ? [a.stakeholderId] : [])),
  );

  const holders: AudienceCandidate[] = stakeholders
    .map((s) => {
      const u = units.get(s.id) ?? { preferred: 0n, common: 0n };
      return {
        stakeholderId: s.id,
        name: s.name,
        memberStatus: s.memberStatus as HolderMemberStatus,
        preferredUnits: fromMicro(u.preferred),
        commonUnits: fromMicro(u.common),
        hasK1: k1For.has(s.id),
        noticeEmail: (s.noticeEmail ?? s.email).trim(),
        portal: portal.get(s.id) ?? "NONE",
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        (a.stakeholderId < b.stakeholderId ? -1 : 1),
    );

  const transferorId = transfer?.fromStakeholderId ?? null;
  const presets = audiencePresets(
    type,
    report.noticeKind,
    holders,
    transferorId,
  );
  const deadlineAudienceIds = isTransferNotice(type, report.noticeKind)
    ? (presets.presets.find((p) => p.key === "OTHER_PREFERRED_MEMBERS")
        ?.stakeholderIds ?? [])
    : holders.filter(isCurrentMember).map((h) => h.stakeholderId);
  return { holders, transferorId, presets, deadlineAudienceIds };
}
