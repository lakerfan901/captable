import type { ResolutionRequirement } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { emitResolutionFinalize } from "@/jobs/governance-resolution-finalize";
import { toDateOnly } from "@/lib/date-only";
import {
  behaviour,
  buildLockedClauses,
  buildRequirements,
  type RequirementSpec,
  type ResolutionType,
} from "@/lib/governance/presets";
import { normalizeBlocks, type RichDoc } from "@/lib/governance/rich-doc";
import type { BasisTally, RequirementState, VoteBasis } from "@/lib/llc/voting";
import type { TPrisma } from "@/server/db";
import {
  evaluateAndTransition,
  loadEvaluation,
  type TransitionResult,
} from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionGetSchema } from "../schema";

// resolution.get (03-governance.md G7). Also exports the read helpers shared
// with list and preview: lazy close, requirement labels, decimal conversion.

type DecimalLike = { toFixed(digits: number): string };

/** Prisma Decimal -> 6-decimal string (null stays null). */
export function units(value: DecimalLike): string;
export function units(value: DecimalLike | null): string | null;
export function units(value: DecimalLike | null): string | null {
  return value === null ? null : value.toFixed(6);
}

function ymdOrNull(d: Date | null): string | null {
  return d === null ? null : toDateOnly(d);
}

const BASIS_LABEL: Record<VoteBasis, string> = {
  PREFERRED_MAJORITY: "Preferred Majority",
  PREFERRED_SUPERMAJORITY: "Preferred Supermajority",
  DISINTERESTED_MAJORITY: "Majority of the Disinterested Preferred Units",
  DISINTERESTED_67: "67% of the Disinterested Preferred Units",
  DISINTERESTED_70: "70% of the Disinterested Preferred Units",
};

export function requirementLabel(r: {
  kind: string;
  basis?: string | null;
}): string {
  switch (r.kind) {
    case "UNIT_VOTE":
      return r.basis ? BASIS_LABEL[r.basis as VoteBasis] : "Unit vote";
    case "MANAGER_APPROVAL":
      return "Approval of the Manager";
    case "COMMON_MEMBER_APPROVAL":
      return "Approval of the Common Member";
    case "AFFECTED_MEMBER_CONSENT":
      return "Consent of an affected Member";
    default:
      return r.kind;
  }
}

/** Requirements of a DRAFT, rebuilt from its params; [] when they no longer validate. */
export function draftSpecs(
  type: ResolutionType,
  params: unknown,
): RequirementSpec[] {
  try {
    return buildRequirements(type, params);
  } catch {
    return [];
  }
}

/**
 * Lazy close (03-governance.md A7, G8 sweep): each SENT resolution whose
 * window has passed is evaluated in its own transaction; finalize is emitted
 * after each commit. The close is not the viewer's act, so the system actor
 * is used (as the sweep does).
 */
export async function closeOverdue(
  db: TPrisma,
  resolutionIds: string[],
  now: Date,
  source: string,
): Promise<void> {
  for (const id of resolutionIds) {
    const transition: TransitionResult | null = await db.$transaction((tx) =>
      evaluateAndTransition(tx, id, now, {
        type: "system",
        id: null,
        ip: "system",
        userAgent: `lazy-close:${source}`,
      }),
    );
    if (transition) await emitResolutionFinalize(transition.resolutionId);
  }
}

type RequirementRowDto = Omit<
  ResolutionRequirement,
  "denominatorUnits" | "minimumForUnits" | "forUnitsAtClose"
> & {
  denominatorUnits: string | null;
  minimumForUnits: string | null;
  forUnitsAtClose: string | null;
};

export type ResolutionRequirementView = Omit<
  RequirementRowDto,
  "id" | "resolutionId" | "companyId"
> & {
  id: string | null;
  label: string;
  tally: BasisTally | null;
  state: RequirementState;
};

function draftRequirement(
  s: RequirementSpec,
  position: number,
): ResolutionRequirementView {
  const r = s.requirement;
  return {
    id: null,
    position,
    kind: r.kind,
    basis: r.kind === "UNIT_VOTE" ? r.basis : null,
    stakeholderId:
      r.kind === "AFFECTED_MEMBER_CONSENT" ? r.stakeholderId : null,
    section: s.section,
    denominatorUnits: null,
    minimumForUnits: null,
    satisfiedAt: null,
    forUnitsAtClose: null,
    approvedByMemberId: null,
    approverName: null,
    approverCapacity: null,
    approvedAt: null,
    approvalIp: null,
    approvalUserAgent: null,
    label: requirementLabel({
      kind: r.kind,
      basis: r.kind === "UNIT_VOTE" ? r.basis : null,
    }),
    tally: null,
    state: "PENDING",
  };
}

export const getProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZResolutionGetSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const found = await ctx.db.resolution.findFirst({
      where: { publicId: input.publicId, companyId },
      select: { id: true, status: true, closesAt: true },
    });
    if (!found) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Resolution not found.",
      });
    }
    if (
      found.status === "SENT" &&
      found.closesAt !== null &&
      found.closesAt.getTime() < now.getTime()
    ) {
      await closeOverdue(ctx.db, [found.id], now, "resolution.get");
    }

    const row = await ctx.db.resolution.findFirst({
      where: { id: found.id, companyId },
    });
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Resolution not found.",
      });
    }
    const type = row.type as ResolutionType;
    const resolution = {
      ...row,
      recordDate: ymdOrNull(row.recordDate),
      copyDueOn: ymdOrNull(row.copyDueOn),
    };

    const [events, executedDocument, emails] = await Promise.all([
      ctx.db.resolutionEvent.findMany({
        where: { resolutionId: row.id, companyId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      }),
      row.executedDocumentId
        ? ctx.db.document.findFirst({
            where: { id: row.executedDocumentId, companyId },
            select: { publicId: true, name: true },
          })
        : Promise.resolve(null),
      // G11: delivery log of this resolution's emails, newest first.
      ctx.db.emailLog.findMany({
        where: { companyId, relatedType: "resolution", relatedId: row.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          stakeholderId: true,
          toAddress: true,
          kind: true,
          status: true,
          sentAt: true,
          bounceState: true,
        },
      }),
    ]);

    const preset = behaviour(type);

    if (row.status === "DRAFT") {
      const specs = draftSpecs(type, row.params);
      let lockedClauses: string[] = [];
      try {
        lockedClauses = buildLockedClauses(type, row.params, {
          companyName: ctx.company.name,
        });
      } catch {
        lockedClauses = [];
      }
      const normalized = normalizeBlocks(row.body);
      const doc: RichDoc = normalized.ok ? normalized.doc : [];
      return {
        resolution,
        preset,
        requirements: specs.map(draftRequirement),
        ballots: [],
        snapshot: null,
        events,
        executedDocument,
        emails,
        starter: { doc, lockedClauses },
      };
    }

    const ev = await loadEvaluation(ctx.db, row.id);
    const requirements: ResolutionRequirementView[] = ev.requirements.map(
      (r, i) => {
        const result = ev.evaluation.results[i];
        return {
          ...r,
          denominatorUnits: units(r.denominatorUnits),
          minimumForUnits: units(r.minimumForUnits),
          forUnitsAtClose: units(r.forUnitsAtClose),
          label: requirementLabel(r),
          tally: result?.tally ?? null,
          state: result?.state ?? "PENDING",
        };
      },
    );
    const ballots = ev.ballots.map((b) => ({
      ...b,
      preferredUnits: units(b.preferredUnits),
      linkState:
        b.tokenRevokedAt !== null
          ? ("REVOKED" as const)
          : b.tokenExpiresAt.getTime() < now.getTime()
            ? ("EXPIRED" as const)
            : ("ACTIVE" as const),
    }));
    const snap = ev.resolution.snapshot;
    const snapshot = snap
      ? {
          recordDate: toDateOnly(snap.recordDate),
          totals: {
            preferredIssued: units(snap.preferredIssued),
            preferredOutstanding: units(snap.preferredOutstanding),
            disinterestedOutstanding: units(snap.disinterestedOutstanding),
          },
          entries: [...snap.entries]
            .sort((a, b) => a.name.localeCompare(b.name, "en"))
            .map((e) => ({
              ...e,
              preferredUnits: units(e.preferredUnits),
              commonUnits: units(e.commonUnits),
            })),
        }
      : null;
    const frozen = (row.frozenContent ?? {}) as {
      doc?: RichDoc;
      lockedClauses?: string[];
    };

    return {
      resolution,
      preset,
      requirements,
      ballots,
      snapshot,
      events,
      executedDocument,
      emails,
      starter: {
        doc: frozen.doc ?? [],
        lockedClauses: frozen.lockedClauses ?? [],
      },
    };
  });
