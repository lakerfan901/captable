import { recordEvent } from "@/server/governance/events";
import { withoutAuth } from "@/trpc/api/trpc";
import { boundRequestMeta } from "../access";
import { ZBallotTokenSchema } from "../schema";
import { resolveOpenBallot } from "./resolve";

// ballot.markViewed (03-governance.md G8). Public; an OK link only (REPLACED
// and every invalid token get the same NOT_FOUND).
//
// Writes nothing but the view metadata of THIS ballot: `firstViewedAt` (set
// once, by a guarded update, so concurrent calls cannot both set it),
// `viewCount + 1`, and one BALLOT_VIEWED event on the first view only. It
// never touches the vote columns, the link columns or the resolution.
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
      const first = await tx.resolutionBallot.updateMany({
        where: {
          id: ballot.id,
          resolutionId: resolution.id,
          firstViewedAt: null,
        },
        data: { firstViewedAt: now },
      });
      // Bounded counter (Int column): stops counting rather than overflow.
      await tx.resolutionBallot.updateMany({
        where: {
          id: ballot.id,
          resolutionId: resolution.id,
          viewCount: { lt: MAX_VIEW_COUNT },
        },
        data: { viewCount: { increment: 1 } },
      });
      if (first.count === 1) {
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
