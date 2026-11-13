import { withoutAuth } from "@/trpc/api/trpc";
import { ZReportTokenSchema } from "../schema";
import { resolveOpenRecipient } from "./resolve";

// memberReportView.markViewed (03-governance.md G12). Public; an OK link only
// (REPLACED and every invalid token get the same NOT_FOUND).
//
// Writes nothing but the view metadata of THIS recipient: `firstViewedAt`
// (set once, by a single-row guarded UPDATE `WHERE firstViewedAt IS NULL`,
// which Postgres re-checks at write time, so of two concurrent first views
// exactly one sets it) and `viewCount + 1` (bounded). The recipient model has
// no IP / user-agent columns, so none are stored. Raw SQL rather than
// `guardedWrite`: losing the first-view race is routine on a public page.
// Call it from the browser (HTTP), not from a Server Component.

const MAX_VIEW_COUNT = 1_000_000;

export const markViewedProcedure = withoutAuth
  .input(ZReportTokenSchema)
  .mutation(async ({ ctx, input }) => {
    const now = new Date();
    const { recipient } = await resolveOpenRecipient(ctx.db, input.token, now);

    await ctx.db.$transaction(async (tx) => {
      if (recipient.firstViewedAt === null) {
        await tx.$executeRaw`
          UPDATE "MemberReportRecipient" SET "firstViewedAt" = ${now}, "updatedAt" = ${now}
          WHERE "id" = ${recipient.id} AND "reportId" = ${recipient.reportId}
            AND "firstViewedAt" IS NULL`;
      }
      await tx.$executeRaw`
        UPDATE "MemberReportRecipient" SET "viewCount" = "viewCount" + 1, "updatedAt" = ${now}
        WHERE "id" = ${recipient.id} AND "reportId" = ${recipient.reportId}
          AND "viewCount" < ${MAX_VIEW_COUNT}`;
    });

    return { ok: true as const };
  });
