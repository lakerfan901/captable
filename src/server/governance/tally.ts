import "server-only";
import { TRPCError } from "@trpc/server";
import { toDateOnly } from "@/lib/date-only";
import {
  GOVERNANCE_TIME_ZONE,
  todayInZone,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import { behaviour, type ResolutionType } from "@/lib/governance/presets";
import { decideTransition } from "@/lib/governance/resolution-core";
import { addBusinessDays } from "@/lib/llc/business-days";
import {
  type ApprovalState,
  type CastVote,
  type Evaluation,
  evaluate,
  type HolderSnapshot,
  type Requirement,
  type VoteBasis,
} from "@/lib/llc/voting";
import { Audit } from "@/server/audit";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import { getOrCreateLlcTerm } from "@/server/llc/economics/term";
import { recordEvent } from "./events";
import { loadLlcCompany } from "./guards";

// Tally and status transition (03-governance.md G6).
//
// Every decision is made from the FROZEN register (RecordSnapshotEntry) and
// the ballots of the resolution; live positions are never read here. Every
// write is a guarded `updateMany` (write-once, C3), and the whole evaluation
// runs under a row lock on the Resolution, so two ballots submitted at the
// same moment cannot both cross (or both miss) the threshold.

export interface GovernanceActor {
  type: "user" | "stakeholder" | "system";
  id: string | null;
  ip: string;
  userAgent: string;
}

export interface TransitionResult {
  resolutionId: string;
  companyId: string;
  to: "EFFECTIVE" | "FAILED" | "EXPIRED";
}

/**
 * Row lock on the resolution (SELECT … FOR UPDATE). Must be called inside an
 * interactive transaction; the lock is held until it commits. Throws
 * NOT_FOUND when the row does not exist.
 */
export async function lockResolution(
  tx: PrismaTransactionalClient,
  resolutionId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Resolution" WHERE "id" = ${resolutionId} FOR UPDATE`;
  if (rows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

async function loadResolutionState(
  tx: TPrismaOrTransaction,
  resolutionId: string,
) {
  const resolution = await tx.resolution.findUnique({
    where: { id: resolutionId },
    include: {
      requirements: { orderBy: { position: "asc" } },
      ballots: { orderBy: [{ name: "asc" }, { id: "asc" }] },
      snapshot: { include: { entries: true } },
    },
  });
  if (!resolution) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return resolution;
}

type ResolutionState = Awaited<ReturnType<typeof loadResolutionState>>;
type RequirementRow = ResolutionState["requirements"][number];

function toRequirement(row: RequirementRow): Requirement {
  switch (row.kind) {
    case "UNIT_VOTE":
      if (row.basis === null) {
        throw new Error(`UNIT_VOTE requirement ${row.id} has no basis`);
      }
      return { kind: "UNIT_VOTE", basis: row.basis };
    case "MANAGER_APPROVAL":
      return { kind: "MANAGER_APPROVAL" };
    case "COMMON_MEMBER_APPROVAL":
      return { kind: "COMMON_MEMBER_APPROVAL" };
    case "AFFECTED_MEMBER_CONSENT":
      if (row.stakeholderId === null) {
        throw new Error(
          `AFFECTED_MEMBER_CONSENT requirement ${row.id} has no stakeholder`,
        );
      }
      return {
        kind: "AFFECTED_MEMBER_CONSENT",
        stakeholderId: row.stakeholderId,
      };
  }
}

/** All rows of `kind` are signed (and at least one exists). */
function allApproved(
  rows: RequirementRow[],
  kind: "MANAGER_APPROVAL" | "COMMON_MEMBER_APPROVAL",
): boolean {
  const of = rows.filter((r) => r.kind === kind);
  return of.length > 0 && of.every((r) => r.approvedAt !== null);
}

function computeEvaluation(state: ResolutionState) {
  if (!state.snapshot) {
    throw new Error(`Resolution ${state.id} has no record snapshot`);
  }
  const holders: HolderSnapshot[] = state.snapshot.entries.map((e) => ({
    stakeholderId: e.stakeholderId,
    preferredUnits: e.preferredUnits.toFixed(6),
    isMember: e.isMember,
    isSuspended: e.isSuspended,
    isInsider: e.isInsider,
  }));
  const votes: CastVote[] = [];
  for (const b of state.ballots) {
    if (b.submittedAt === null) continue;
    if (b.choice === null) {
      throw new Error(`Submitted ballot ${b.id} has no choice`);
    }
    votes.push({ stakeholderId: b.stakeholderId, choice: b.choice });
  }
  const approvals: ApprovalState = {
    managerApproved: allApproved(state.requirements, "MANAGER_APPROVAL"),
    commonMemberApproved: allApproved(
      state.requirements,
      "COMMON_MEMBER_APPROVAL",
    ),
  };
  const requirements = state.requirements.map(toRequirement);
  const evaluation: Evaluation = evaluate(
    requirements,
    holders,
    votes,
    approvals,
  );
  return { holders, votes, approvals, evaluation };
}

/**
 * Loads a sent resolution with its requirements (by position), ballots and
 * frozen register, and evaluates it. Read-only; the caller has already
 * scoped `resolutionId` to its company. `evaluation.results[i]` belongs to
 * `requirements[i]`. Throws for a resolution without a snapshot (DRAFT).
 */
export async function loadEvaluation(
  tx: TPrismaOrTransaction,
  resolutionId: string,
): Promise<{
  resolution: ResolutionState;
  requirements: ResolutionState["requirements"];
  ballots: ResolutionState["ballots"];
  holders: HolderSnapshot[];
  votes: CastVote[];
  approvals: ApprovalState;
  evaluation: Evaluation;
}> {
  const resolution = await loadResolutionState(tx, resolutionId);
  const computed = computeEvaluation(resolution);
  return {
    resolution,
    requirements: resolution.requirements,
    ballots: resolution.ballots,
    ...computed,
  };
}

const BASIS_LABEL: Record<VoteBasis, string> = {
  PREFERRED_MAJORITY: "Preferred Majority",
  PREFERRED_SUPERMAJORITY: "Preferred Supermajority",
  DISINTERESTED_MAJORITY: "majority of the Disinterested Preferred Units",
  DISINTERESTED_67: "67% of the Disinterested Preferred Units",
  DISINTERESTED_70: "70% of the Disinterested Preferred Units",
};

function requirementLabel(row: RequirementRow): string {
  switch (row.kind) {
    case "UNIT_VOTE":
      return row.basis ? BASIS_LABEL[row.basis] : "unit vote";
    case "MANAGER_APPROVAL":
      return "approval of the Manager";
    case "COMMON_MEMBER_APPROVAL":
      return "approval of the Common Member";
    case "AFFECTED_MEMBER_CONSENT":
      return "consent of an affected Member";
  }
}

const TRANSITION_AUDIT = {
  EFFECTIVE: "resolution.effective",
  FAILED: "resolution.failed",
  EXPIRED: "resolution.expired",
} as const;

const TRANSITION_VERB = {
  EFFECTIVE: "became effective",
  FAILED: "failed",
  EXPIRED: "expired",
} as const;

/**
 * Evaluates a SENT resolution against its frozen register and, when the
 * outcome is decided, moves it to EFFECTIVE / FAILED / EXPIRED. MUST be
 * called inside an interactive transaction (it takes the row lock). Returns
 * null when nothing transitions. Emits no jobs: after the transaction
 * commits, the caller emits `emitResolutionFinalize(resolutionId)` (G9).
 */
export async function evaluateAndTransition(
  tx: PrismaTransactionalClient,
  resolutionId: string,
  now: Date,
  actor: GovernanceActor,
): Promise<TransitionResult | null> {
  // 1. Lock, then reload everything (never reuse rows read before the lock).
  await lockResolution(tx, resolutionId);
  let state = await loadResolutionState(tx, resolutionId);
  if (state.status !== "SENT") return null;

  const type = state.type as ResolutionType;
  const preset = behaviour(type);
  const companyId = state.companyId;
  const refLabel = state.referenceCode ?? state.title;
  const eventActor = {
    actorType: actor.type,
    actorId: actor.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
  };
  const auditContext = { requestIp: actor.ip, userAgent: actor.userAgent };

  // 2. Evaluate on the frozen register.
  let { evaluation } = computeEvaluation(state);

  // 3. OA 2.5 (R14): after the window closes, every eligible non-responder
  //    is deemed to have voted Against. Write-once per ballot.
  const closed =
    state.closesAt !== null && now.getTime() > state.closesAt.getTime();
  if (
    evaluation.outcome === "PENDING" &&
    closed &&
    state.closesAt !== null &&
    preset.deemedAgainstAtClose
  ) {
    const closesAt = state.closesAt;
    let deemedAny = false;
    for (const ballot of state.ballots) {
      if (ballot.submittedAt !== null) continue;
      if (!ballot.countsPreferred && !ballot.countsDisinterested) continue;
      const { count } = await tx.resolutionBallot.updateMany({
        where: { id: ballot.id, resolutionId, submittedAt: null },
        data: {
          choice: "AGAINST",
          deemed: true,
          submittedAt: closesAt,
          bodyHash: state.frozenHash,
        },
      });
      if (count !== 1) continue;
      deemedAny = true;
      await recordEvent(tx, {
        resolutionId,
        companyId,
        ballotId: ballot.id,
        type: "BALLOT_DEEMED",
        actorType: "system",
        actorId: null,
        summary: `${ballot.name} did not respond within the response period and is deemed to have voted Against (Section 2.5)`,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      await Audit.create(
        {
          action: "ballot.deemed",
          companyId,
          actor: { type: "system", id: null },
          context: auditContext,
          target: [
            { type: "resolution", id: resolutionId },
            { type: "ballot", id: ballot.id },
          ],
          summary: `${ballot.name} deemed to have voted Against on ${refLabel} (Section 2.5)`,
        },
        tx,
      );
    }
    if (deemedAny) {
      state = await loadResolutionState(tx, resolutionId);
      ({ evaluation } = computeEvaluation(state));
    }
  }

  // 4. Record each requirement the first time it is satisfied (write-once).
  for (const [i, row] of state.requirements.entries()) {
    const result = evaluation.results[i];
    if (!result) throw new Error("Evaluation does not match requirements");
    if (result.state !== "PASSED" || row.satisfiedAt !== null) continue;
    const { count } = await tx.resolutionRequirement.updateMany({
      where: { id: row.id, resolutionId, satisfiedAt: null },
      data: {
        satisfiedAt: now,
        ...(row.kind === "UNIT_VOTE" && result.tally
          ? { forUnitsAtClose: result.tally.for }
          : {}),
      },
    });
    if (count !== 1) continue;
    await recordEvent(tx, {
      resolutionId,
      companyId,
      type: "REQUIREMENT_SATISFIED",
      ...eventActor,
      summary: `Requirement satisfied: ${requirementLabel(row)} (Section ${row.section})${
        result.tally ? `, ${result.tally.for} Preferred Units For` : ""
      }`,
    });
  }

  // 5. Decide.
  const to = decideTransition({
    status: state.status,
    closesAt: state.closesAt,
    now,
    outcome: evaluation.outcome,
    deemedAgainstAtClose: preset.deemedAgainstAtClose,
  });
  if (to === null) return null;

  // 7 (computed first so it is written with the status). PURCHASE_ORDER
  //    (R16): a copy is due to the Members within n business days.
  let copyDueOn: string | null = null;
  const copyDays = preset.copyToMembersBusinessDays;
  if (to === "EFFECTIVE" && copyDays !== null) {
    const company = await loadLlcCompany(tx, companyId);
    const term = await getOrCreateLlcTerm(tx, companyId);
    const zone = company.timezone || GOVERNANCE_TIME_ZONE;
    copyDueOn = addBusinessDays(todayInZone(now, zone), copyDays, {
      holidays: term.holidayCalendar,
      saturdayObservedOnFriday: term.saturdayHolidayObservedFriday,
      extraHolidays: term.extraHolidays.map(toDateOnly),
    });
  }

  // 6. Transition (guarded: only from SENT).
  const { count } = await tx.resolution.updateMany({
    where: { id: resolutionId, status: "SENT" },
    data:
      to === "EFFECTIVE"
        ? {
            status: "EFFECTIVE",
            effectiveAt: now,
            ...(copyDueOn !== null
              ? { copyDueOn: ymdToUtcDate(copyDueOn) }
              : {}),
          }
        : { status: to, closedAt: now },
  });
  if (count !== 1) {
    throw new Error(`Resolution ${resolutionId} left SENT concurrently`);
  }

  for (const [i, row] of state.requirements.entries()) {
    if (row.kind !== "UNIT_VOTE") continue;
    const tally = evaluation.results[i]?.tally;
    if (!tally) continue;
    await tx.resolutionRequirement.updateMany({
      where: { id: row.id, resolutionId, forUnitsAtClose: null },
      data: { forUnitsAtClose: tally.for },
    });
  }

  await recordEvent(tx, {
    resolutionId,
    companyId,
    type: to,
    ...eventActor,
    summary: `${refLabel} ${TRANSITION_VERB[to]}`,
  });
  await Audit.create(
    {
      action: TRANSITION_AUDIT[to],
      companyId,
      actor: { type: actor.type, id: actor.id },
      context: auditContext,
      target: [{ type: "resolution", id: resolutionId }],
      summary: `${refLabel} "${state.title}" ${TRANSITION_VERB[to]}`,
    },
    tx,
  );

  if (copyDueOn !== null) {
    const dedupeKey = `PO_RESOLUTION_COPY:${resolutionId}`;
    await tx.complianceDeadline.upsert({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
      create: {
        companyId,
        ruleKey: "PO_RESOLUTION_COPY",
        dedupeKey,
        title: `Deliver a copy of ${refLabel} to the Members`,
        section: "6.16(i)(B)",
        dueOn: ymdToUtcDate(copyDueOn),
        source: "RESOLUTION",
        sourceType: "RESOLUTION",
        sourceId: resolutionId,
      },
      update: {},
    });
  }

  // 8. The caller emits the finalize job after the transaction commits.
  return { resolutionId, companyId, to };
}
