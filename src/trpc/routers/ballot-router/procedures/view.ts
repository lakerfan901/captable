import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { toDateOnly } from "@/lib/date-only";
import { behaviour, type ResolutionType } from "@/lib/governance/presets";
import { type RichDoc, RichDocSchema } from "@/lib/governance/rich-doc";
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
// affected Member, so only `doc` and `lockedClauses` are read from it).

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

function toView(resolved: Extract<ResolvedBallot, { kind: "OK" }>) {
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
    resolution: {
      title: resolution.title,
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
  .query(async ({ ctx, input }) => {
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

    return toView(resolved);
  });

export type BallotView = Awaited<ReturnType<typeof toView>>;
