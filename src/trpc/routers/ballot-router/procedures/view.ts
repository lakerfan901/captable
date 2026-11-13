import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { toDateOnly } from "@/lib/date-only";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { behaviour, type ResolutionType } from "@/lib/governance/presets";
import { type RichDoc, RichDocSchema } from "@/lib/governance/rich-doc";
import type { TPrismaOrTransaction } from "@/server/db";
import { frozenTitle } from "@/server/governance/frozen";
import { withoutAuth } from "@/trpc/api/trpc";
import { closeOverdue } from "../../resolution-router/procedures/get";
import { ballotPageState } from "../access";
import { ZBallotTokenSchema } from "../schema";
import { type ResolvedBallot, resolveBallot } from "./resolve";

// ballot.view (03-governance.md G8). Public: the token is the credential.
//
// Returns ONLY what this ballot holder may see: the frozen text of the
// resolution, its dates and status, and this holder's own ballot. Never other
// Members (names, emails, units or votes), never a tally, never an IP, user
// agent, email or internal id. The output is built field by field; no row and
// no `frozenContent` is passed through (its `requirements` labels can name an
// affected Member and its `params` are not for the holder, so only `title`,
// `doc` and `lockedClauses` are read from it).
//
// It also says whether the resolution needs a Disinterested vote (so the page
// can tell an insider that its units do not count toward it; never a tally)
// and the company's time zone (dates on the page are shown in it, as `send`
// computes them).
//
// A MUTATION (POST), like every public ballot procedure: the token is a
// credential and must never travel in a URL (tRPC sends query inputs in the
// query string, which reaches access logs, proxies and Sentry).

const FrozenTextSchema = z.object({
  doc: RichDocSchema,
  lockedClauses: z.array(z.string().max(20_000)).max(200).default([]),
});

function frozenText(frozenContent: unknown): {
  doc: RichDoc;
  lockedClauses: string[];
} {
  const parsed = FrozenTextSchema.safeParse(frozenContent);
  if (!parsed.success) {
    // Data integrity problem on a sent resolution; reveal nothing about it.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  }
  return parsed.data;
}

const DISINTERESTED_BASES = [
  "DISINTERESTED_MAJORITY",
  "DISINTERESTED_67",
  "DISINTERESTED_70",
] as const;

async function hasDisinterestedVote(
  db: TPrismaOrTransaction,
  resolutionId: string,
): Promise<boolean> {
  const row = await db.resolutionRequirement.findFirst({
    where: {
      resolutionId,
      kind: "UNIT_VOTE",
      basis: { in: [...DISINTERESTED_BASES] },
    },
    select: { id: true },
  });
  return row !== null;
}

function toView(
  resolved: Extract<ResolvedBallot, { kind: "OK" }>,
  hasDisinterestedRequirement: boolean,
) {
  const { ballot, resolution, company } = resolved;
  const type = resolution.type as ResolutionType;
  const preset = behaviour(type);
  const { doc, lockedClauses } = frozenText(resolution.frozenContent);
  if (resolution.frozenHash === null) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  }
  return {
    state: ballotPageState(resolution.status, ballot.submittedAt),
    company: { name: company.name, logo: company.logo },
    timeZone: company.timezone || GOVERNANCE_TIME_ZONE,
    resolution: {
      title: frozenTitle(resolution),
      referenceCode: resolution.referenceCode,
      type,
      kindLabel: preset.kindLabel,
      status: resolution.status,
      recordDate:
        resolution.recordDate === null
          ? null
          : toDateOnly(resolution.recordDate),
      sentAt: resolution.sentAt,
      closesAt: resolution.closesAt,
      effectiveAt: resolution.effectiveAt,
      closedAt: resolution.closedAt,
      withdrawnReason: resolution.withdrawnReason,
      doc,
      lockedClauses,
      frozenHash: resolution.frozenHash,
      deemedAgainstAtClose: preset.deemedAgainstAtClose,
      hasDisinterestedRequirement,
      hasExecutedPdf:
        resolution.status === "EFFECTIVE" &&
        resolution.executedDocumentId !== null,
    },
    ballot: {
      name: ballot.name,
      preferredUnits: ballot.preferredUnits.toFixed(6),
      countsPreferred: ballot.countsPreferred,
      countsDisinterested: ballot.countsDisinterested,
      choice: ballot.choice,
      deemed: ballot.deemed,
      signedName: ballot.signedName,
      signerCapacity: ballot.signerCapacity,
      submittedAt: ballot.submittedAt,
    },
  };
}

export const viewProcedure = withoutAuth
  .input(ZBallotTokenSchema)
  .mutation(async ({ ctx, input }) => {
    const now = new Date();
    let resolved = await resolveBallot(ctx.db, input.token, now);
    if (resolved.kind === "REPLACED") {
      return { state: "REPLACED" as const, company: resolved.company };
    }

    // Close on read (A7 trap): a SENT resolution whose window has passed is
    // evaluated (deemed-against ballots under 2.5, status change) in its own
    // transaction with the system actor; finalize is emitted after commit.
    const { resolution } = resolved;
    if (
      resolution.status === "SENT" &&
      resolution.closesAt !== null &&
      resolution.closesAt.getTime() < now.getTime()
    ) {
      await closeOverdue(ctx.db, [resolution.id], now, "ballot.view");
      resolved = await resolveBallot(ctx.db, input.token, now);
      if (resolved.kind === "REPLACED") {
        return { state: "REPLACED" as const, company: resolved.company };
      }
    }

    return toView(
      resolved,
      await hasDisinterestedVote(ctx.db, resolved.resolution.id),
    );
  });

export type BallotView = Awaited<ReturnType<typeof toView>>;
