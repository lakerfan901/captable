// Resolution decision logic (03-governance.md G6). Pure: no database, no
// Date reads, no `@/` imports. The server wrappers in
// `src/server/governance/**` load rows and call these functions.

import {
  denominator,
  fromMicro,
  isDisinterestedBasis,
  isEligible,
  type Requirement,
  toMicro,
  type VoteBasis,
} from "../llc/voting";

export interface StakeholderRow {
  id: string;
  name: string;
  email: string;
  noticeEmail: string | null;
  memberStatus: string;
  isInsider: boolean;
}

export interface UnitPosition {
  stakeholderId: string;
  unitClassId: string;
  unitClassKind: "PREFERRED" | "COMMON";
  units: string;
  suspended: boolean;
}

export interface SnapshotEntryDraft {
  stakeholderId: string;
  name: string;
  email: string;
  memberStatus: string;
  isMember: boolean;
  isInsider: boolean;
  isSuspended: boolean;
  preferredUnits: string;
  commonUnits: string;
}

function byName<T extends { name: string; stakeholderId: string }>(
  a: T,
  b: T,
): number {
  const n = a.name.localeCompare(b.name, "en");
  if (n !== 0) return n;
  return a.stakeholderId < b.stakeholderId
    ? -1
    : a.stakeholderId > b.stakeholderId
      ? 1
      : 0;
}

/**
 * One entry per stakeholder that is a MEMBER or FINANCIAL_INTEREST_ONLY, or
 * holds any units. Totals follow OA 1.23 (R2) and 1.18 (R3).
 */
export function buildSnapshotEntries(
  stakeholders: StakeholderRow[],
  positions: UnitPosition[],
): {
  entries: SnapshotEntryDraft[];
  preferredIssued: string;
  preferredOutstanding: string;
  disinterestedOutstanding: string;
} {
  const known = new Map<string, StakeholderRow>();
  for (const s of stakeholders) {
    if (known.has(s.id)) throw new Error(`Duplicate stakeholder ${s.id}`);
    known.set(s.id, s);
  }

  const acc = new Map<
    string,
    { preferred: bigint; common: bigint; suspended: boolean }
  >();
  for (const p of positions) {
    if (!known.has(p.stakeholderId)) {
      throw new Error(
        `Unit position for unknown stakeholder ${p.stakeholderId}`,
      );
    }
    const micro = toMicro(p.units);
    const row = acc.get(p.stakeholderId) ?? {
      preferred: 0n,
      common: 0n,
      suspended: false,
    };
    if (p.unitClassKind === "PREFERRED") {
      row.preferred += micro;
      if (p.suspended) row.suspended = true;
    } else if (p.unitClassKind === "COMMON") {
      row.common += micro;
    } else {
      throw new Error(`Unknown unit class kind for ${p.stakeholderId}`);
    }
    acc.set(p.stakeholderId, row);
  }

  const entries: SnapshotEntryDraft[] = [];
  for (const s of stakeholders) {
    const units = acc.get(s.id);
    const hasUnits =
      units !== undefined && (units.preferred > 0n || units.common > 0n);
    const isHolderStatus =
      s.memberStatus === "MEMBER" ||
      s.memberStatus === "FINANCIAL_INTEREST_ONLY";
    if (!isHolderStatus && !hasUnits) continue;
    entries.push({
      stakeholderId: s.id,
      name: s.name,
      email: s.noticeEmail ?? s.email,
      memberStatus: s.memberStatus,
      isMember: s.memberStatus === "MEMBER",
      isInsider: s.isInsider,
      isSuspended: units?.suspended ?? false,
      preferredUnits: fromMicro(units?.preferred ?? 0n),
      commonUnits: fromMicro(units?.common ?? 0n),
    });
  }
  entries.sort(byName);

  let issued = 0n;
  for (const e of entries) issued += toMicro(e.preferredUnits);

  return {
    entries,
    preferredIssued: fromMicro(issued),
    preferredOutstanding: fromMicro(denominator(entries, "PREFERRED_MAJORITY")),
    disinterestedOutstanding: fromMicro(
      denominator(entries, "DISINTERESTED_MAJORITY"),
    ),
  };
}

/**
 * Stakeholder ids that must/may receive a ballot for these requirements.
 * A stakeholder named by AFFECTED_MEMBER_CONSENT that is not among `entries`
 * is omitted (the caller rejects such a requirement before sending).
 */
export function eligibleRecipients(
  entries: SnapshotEntryDraft[],
  requirements: Requirement[],
): {
  stakeholderId: string;
  countsPreferred: boolean;
  countsDisinterested: boolean;
  consentOnly: boolean;
}[] {
  const bases: VoteBasis[] = [];
  const consentIds = new Set<string>();
  for (const r of requirements) {
    if (r.kind === "UNIT_VOTE") bases.push(r.basis);
    else if (r.kind === "AFFECTED_MEMBER_CONSENT")
      consentIds.add(r.stakeholderId);
  }
  const preferredBases = bases.filter((b) => !isDisinterestedBasis(b));
  const disinterestedBases = bases.filter((b) => isDisinterestedBasis(b));

  const out: {
    name: string;
    stakeholderId: string;
    countsPreferred: boolean;
    countsDisinterested: boolean;
    consentOnly: boolean;
  }[] = [];
  for (const e of entries) {
    const countsPreferred = preferredBases.some((b) => isEligible(e, b));
    const countsDisinterested = disinterestedBases.some((b) =>
      isEligible(e, b),
    );
    const named = consentIds.has(e.stakeholderId);
    if (!countsPreferred && !countsDisinterested && !named) continue;
    out.push({
      name: e.name,
      stakeholderId: e.stakeholderId,
      countsPreferred,
      countsDisinterested,
      consentOnly: named && !countsPreferred && !countsDisinterested,
    });
  }
  out.sort(byName);
  return out.map(
    ({ stakeholderId, countsPreferred, countsDisinterested, consentOnly }) => ({
      stakeholderId,
      countsPreferred,
      countsDisinterested,
      consentOnly,
    }),
  );
}

export type Transition = "EFFECTIVE" | "FAILED" | "EXPIRED" | null;

export function decideTransition(input: {
  status: string;
  closesAt: Date | null;
  now: Date;
  outcome: "PASSED" | "PENDING" | "CANNOT_PASS";
  deemedAgainstAtClose: boolean;
}): Transition {
  if (input.status !== "SENT") return null;
  if (input.outcome === "PASSED") return "EFFECTIVE";
  if (input.outcome === "CANNOT_PASS") return "FAILED";
  if (
    input.closesAt !== null &&
    input.now.getTime() > input.closesAt.getTime()
  ) {
    return input.deemedAgainstAtClose ? "FAILED" : "EXPIRED";
  }
  return null;
}

/** "R-2026-003" given the codes already used by the company. */
export function nextReferenceCode(existing: string[], year: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`Invalid year ${year}`);
  }
  const re = new RegExp(`^R-${year}-(\\d{3,})$`);
  let highest = 0;
  for (const code of existing) {
    const m = re.exec(code);
    if (!m?.[1]) continue;
    const seq = Number.parseInt(m[1], 10);
    if (seq > highest) highest = seq;
  }
  return `R-${year}-${String(highest + 1).padStart(3, "0")}`;
}
