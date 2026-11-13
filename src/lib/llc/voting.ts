/**
 * LLC voting math (Operating Agreement 1.18, 1.23, 2.5, 4.9, 6.9, 6.12, 6.20, 12.1).
 *
 * Pure and dependency-free: all unit arithmetic is done on bigint micro-units
 * (6 decimal places). No floats, no Date, no Prisma.
 */

export const UNIT_SCALE = 1_000_000n; // 6 decimal places

const UNITS_RE = /^\d{1,14}(\.\d{1,6})?$/;

/** Accepts /^\d{1,14}(\.\d{1,6})?$/ only. Throws RangeError otherwise (negative, exponent, >6 dp, empty). */
export function toMicro(units: string): bigint {
  if (typeof units !== "string" || !UNITS_RE.test(units)) {
    throw new RangeError(`Invalid unit amount: "${String(units)}"`);
  }
  const [whole = "0", frac = ""] = units.split(".");
  return BigInt(whole) * UNIT_SCALE + BigInt(frac.padEnd(6, "0"));
}

/** Always 6 decimals: 525000001n -> "525.000001"; 0n -> "0.000000". Throws RangeError on negative. */
export function fromMicro(micro: bigint): string {
  if (micro < 0n) {
    throw new RangeError("Negative unit amount");
  }
  const whole = micro / UNIT_SCALE;
  const frac = micro % UNIT_SCALE;
  return `${whole.toString()}.${frac.toString().padStart(6, "0")}`;
}

export type VoteBasis =
  | "PREFERRED_MAJORITY"
  | "PREFERRED_SUPERMAJORITY"
  | "DISINTERESTED_MAJORITY"
  | "DISINTERESTED_67"
  | "DISINTERESTED_70";
export type Choice = "FOR" | "AGAINST" | "ABSTAIN";

export interface HolderSnapshot {
  stakeholderId: string;
  preferredUnits: string; // decimal string
  isMember: boolean; // memberStatus === MEMBER at snapshot
  isSuspended: boolean; // OA 4.9(iii)
  isInsider: boolean; // not disinterested (OA 1.18)
}
export interface CastVote {
  stakeholderId: string;
  choice: Choice;
}

export type Requirement =
  | { kind: "UNIT_VOTE"; basis: VoteBasis }
  | { kind: "MANAGER_APPROVAL" }
  | { kind: "COMMON_MEMBER_APPROVAL" }
  | { kind: "AFFECTED_MEMBER_CONSENT"; stakeholderId: string };

/** A resolution that only the Manager signs (purchase-order resolution, R16). */
export const MANAGER_ONLY: readonly Requirement[] = Object.freeze([
  { kind: "MANAGER_APPROVAL" },
]);

export function isDisinterestedBasis(basis: VoteBasis): boolean {
  return (
    basis === "DISINTERESTED_MAJORITY" ||
    basis === "DISINTERESTED_67" ||
    basis === "DISINTERESTED_70"
  );
}

/** R2/R3: isMember && !isSuspended && units > 0 && (!isDisinterestedBasis(basis) || !isInsider). */
export function isEligible(holder: HolderSnapshot, basis: VoteBasis): boolean {
  return (
    holder.isMember &&
    !holder.isSuspended &&
    toMicro(holder.preferredUnits) > 0n &&
    (!isDisinterestedBasis(basis) || !holder.isInsider)
  );
}

export function denominator(
  holders: readonly HolderSnapshot[],
  basis: VoteBasis,
): bigint {
  let total = 0n;
  for (const h of holders) {
    if (isEligible(h, basis)) total += toMicro(h.preferredUnits);
  }
  return total;
}

/** Smallest For-weight that passes, or null when the denominator is 0. */
export function minimumFor(
  denominatorMicro: bigint,
  basis: VoteBasis,
): bigint | null {
  const den = denominatorMicro;
  if (den === 0n) return null;
  switch (basis) {
    case "PREFERRED_MAJORITY":
    case "DISINTERESTED_MAJORITY":
      return den / 2n + 1n;
    case "PREFERRED_SUPERMAJORITY":
    case "DISINTERESTED_70":
      return (den * 7n + 9n) / 10n;
    case "DISINTERESTED_67":
      return (den * 67n + 99n) / 100n;
  }
}

export function meetsThreshold(
  forMicro: bigint,
  denominatorMicro: bigint,
  basis: VoteBasis,
): boolean {
  const den = denominatorMicro;
  if (den === 0n) return false;
  switch (basis) {
    case "PREFERRED_MAJORITY":
    case "DISINTERESTED_MAJORITY":
      return forMicro * 2n > den;
    case "PREFERRED_SUPERMAJORITY":
    case "DISINTERESTED_70":
      return forMicro * 10n >= den * 7n;
    case "DISINTERESTED_67":
      return forMicro * 100n >= den * 67n;
  }
}

export interface BasisTally {
  basis: VoteBasis;
  denominator: string;
  minimumFor: string | null;
  for: string;
  against: string;
  abstain: string;
  notVoted: string;
  eligibleCount: number;
  forCount: number;
  againstCount: number;
  abstainCount: number;
  forBps: number; // floor(for * 10000 / denominator); 0 when denominator is 0. DISPLAY ONLY.
  passed: boolean;
  cannotPass: boolean; // for + notVoted < minimumFor, or denominator is 0
}

function indexVotes(votes: readonly CastVote[]): Map<string, Choice> {
  const map = new Map<string, Choice>();
  for (const v of votes) {
    if (map.has(v.stakeholderId)) throw new Error("duplicate vote");
    map.set(v.stakeholderId, v.choice);
  }
  return map;
}

export function tallyBasis(
  holders: readonly HolderSnapshot[],
  votes: readonly CastVote[],
  basis: VoteBasis,
): BasisTally {
  const byHolder = indexVotes(votes);
  let den = 0n;
  let forW = 0n;
  let againstW = 0n;
  let abstainW = 0n;
  let eligibleCount = 0;
  let forCount = 0;
  let againstCount = 0;
  let abstainCount = 0;

  for (const h of holders) {
    if (!isEligible(h, basis)) continue;
    const units = toMicro(h.preferredUnits);
    den += units;
    eligibleCount += 1;
    const choice = byHolder.get(h.stakeholderId);
    if (choice === "FOR") {
      forW += units;
      forCount += 1;
    } else if (choice === "AGAINST") {
      againstW += units;
      againstCount += 1;
    } else if (choice === "ABSTAIN") {
      abstainW += units;
      abstainCount += 1;
    }
  }

  const notVoted = den - forW - againstW - abstainW;
  const min = minimumFor(den, basis);
  const passed = meetsThreshold(forW, den, basis);
  const cannotPass = min === null || forW + notVoted < min;
  const forBps = den === 0n ? 0 : Number((forW * 10_000n) / den);

  return {
    basis,
    denominator: fromMicro(den),
    minimumFor: min === null ? null : fromMicro(min),
    for: fromMicro(forW),
    against: fromMicro(againstW),
    abstain: fromMicro(abstainW),
    notVoted: fromMicro(notVoted),
    eligibleCount,
    forCount,
    againstCount,
    abstainCount,
    forBps,
    passed,
    cannotPass,
  };
}

export interface ApprovalState {
  managerApproved: boolean;
  commonMemberApproved: boolean;
}
export type RequirementState = "PASSED" | "PENDING" | "CANNOT_PASS";
export interface RequirementResult {
  requirement: Requirement;
  state: RequirementState;
  tally: BasisTally | null;
}
export interface Evaluation {
  outcome: RequirementState;
  results: RequirementResult[];
}

export function evaluate(
  requirements: readonly Requirement[],
  holders: readonly HolderSnapshot[],
  votes: readonly CastVote[],
  approvals: ApprovalState,
): Evaluation {
  if (requirements.length === 0) {
    throw new Error("A resolution needs at least one requirement");
  }
  const byHolder = indexVotes(votes);

  const evaluateOne = (requirement: Requirement): RequirementResult => {
    switch (requirement.kind) {
      case "UNIT_VOTE": {
        const tally = tallyBasis(holders, votes, requirement.basis);
        const state: RequirementState = tally.passed
          ? "PASSED"
          : tally.cannotPass
            ? "CANNOT_PASS"
            : "PENDING";
        return { requirement, state, tally };
      }
      case "MANAGER_APPROVAL":
        return {
          requirement,
          state: approvals.managerApproved ? "PASSED" : "PENDING",
          tally: null,
        };
      case "COMMON_MEMBER_APPROVAL":
        return {
          requirement,
          state: approvals.commonMemberApproved ? "PASSED" : "PENDING",
          tally: null,
        };
      case "AFFECTED_MEMBER_CONSENT": {
        const choice = byHolder.get(requirement.stakeholderId);
        const state: RequirementState =
          choice === "FOR"
            ? "PASSED"
            : choice === undefined
              ? "PENDING"
              : "CANNOT_PASS";
        return { requirement, state, tally: null };
      }
    }
  };
  const results: RequirementResult[] = [];
  for (const requirement of requirements) {
    results.push(evaluateOne(requirement));
  }

  const outcome: RequirementState = results.some(
    (r) => r.state === "CANNOT_PASS",
  )
    ? "CANNOT_PASS"
    : results.every((r) => r.state === "PASSED")
      ? "PASSED"
      : "PENDING";

  return { outcome, results };
}

/** OA 2.5: returns votes plus an AGAINST for every holder eligible for at least one of `bases` that has no vote. */
export function applyDeemedAgainst(
  holders: readonly HolderSnapshot[],
  votes: readonly CastVote[],
  bases: readonly VoteBasis[],
): { votes: CastVote[]; deemedStakeholderIds: string[] } {
  const byHolder = indexVotes(votes);
  const out: CastVote[] = [...votes];
  const deemedStakeholderIds: string[] = [];
  for (const h of holders) {
    if (byHolder.has(h.stakeholderId)) continue;
    if (!bases.some((b) => isEligible(h, b))) continue;
    out.push({ stakeholderId: h.stakeholderId, choice: "AGAINST" });
    deemedStakeholderIds.push(h.stakeholderId);
    byHolder.set(h.stakeholderId, "AGAINST");
  }
  return { votes: out, deemedStakeholderIds };
}
