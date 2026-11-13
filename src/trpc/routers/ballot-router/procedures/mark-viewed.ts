import { recordEvent } from "@/server/governance/events";
import { withoutAuth } from "@/trpc/api/trpc";
import { boundRequestMeta } from "../access";
import { ZBallotTokenSchema } from "../schema";
import { resolveOpenBallot } from "./resolve";

// ballot.markViewed (03-governance.md G8). Public; an OK link only (REPLACED
// and every invalid token get the same NOT_FOUND).
//
// Writes nothing but the view metadata of THIS ballot: `firstViewedAt` (set
// once, by a single-row guarded UPDATE `WHERE firstViewedAt IS NULL`, which
// Postgres re-checks at write time, so of two concurrent first views exactly
// one sets it), `viewCount + 1`, and one BALLOT_VIEWED event written in the
// same transaction as the winning `firstViewedAt` only. It never touches the
// vote columns, the link columns or the resolution.
// Call it from the browser (HTTP), not from a Server Component: the RSC
// caller reports 127.0.0.1 and an empty user agent (A1).

const MAX_VIEW_COUNT = 1_000_000;

export const markViewedProcedure = withoutAuth
  .input(ZBallotTokenSchema)
  .mutation(async ({ ctx, input }) => {
    const now = new Date();
    const { ballot, resolution } = await resolveOpenBallot(
      ctx.db,
      input.token,
      now,
    );
    const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);

    await ctx.db.$transaction(async (tx) => {
      // ONE guarded statement each (Postgres re-checks the WHERE at write
      // time; see server/governance/guarded.ts). Raw SQL rather than
      // `guardedWrite` because losing this race is routine on a public page
      // (two tabs, a double effect) and must not be logged as an error.
      // A guarded `updateMany` would let both callers "win".
      const first =
        ballot.firstViewedAt !== null
          ? 0
          : await tx.$executeRaw`
              UPDATE "ResolutionBallot" SET "firstViewedAt" = ${now}, "updatedAt" = ${now}
              WHERE "id" = ${ballot.id} AND "resolutionId" = ${resolution.id}
                AND "firstViewedAt" IS NULL`;
      // Bounded counter (Int column): stops counting rather than overflow.
      await tx.$executeRaw`
        UPDATE "ResolutionBallot" SET "viewCount" = "viewCount" + 1, "updatedAt" = ${now}
        WHERE "id" = ${ballot.id} AND "resolutionId" = ${resolution.id}
          AND "viewCount" < ${MAX_VIEW_COUNT}`;
      if (first === 1) {
        await recordEvent(tx, {
          resolutionId: resolution.id,
          companyId: resolution.companyId,
          ballotId: ballot.id,
          type: "BALLOT_VIEWED",
          actorType: "stakeholder",
          actorId: ballot.stakeholderId,
          summary: `${ballot.name} opened the ballot`,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    });

    return { ok: true as const };
  });
