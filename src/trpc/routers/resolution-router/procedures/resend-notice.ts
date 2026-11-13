import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  emitResolutionNotices,
  type ResolutionNoticeJobData,
} from "@/jobs/governance-resolution-notice";
import { withLlcAccessControl } from "@/trpc/api/trpc";

// resolution.resendNotice (03-governance.md G9): re-sends the result notice
// (or purchase-order copy) to one Member of the frozen register. No audit row:
// the notice job records its own event. Always a fresh key (max seq + 1 over
// the claims already recorded), so it is also the recovery path for a notice
// whose claim was taken but never sent (M1).

const CLOSED = ["EFFECTIVE", "FAILED", "EXPIRED", "WITHDRAWN"] as const;

export const resendNoticeProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(
    // Bounded like every other resolution input (L6).
    z
      .object({
        publicId: z.string().trim().min(1).max(64),
        stakeholderId: z.string().trim().min(1).max(64),
      })
      .strict(),
  )
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const resolution = await ctx.db.resolution.findFirst({
      where: { publicId: input.publicId, companyId },
      select: { id: true, type: true, status: true, snapshotId: true },
    });
    if (!resolution) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Resolution not found.",
      });
    }
    if (!(CLOSED as readonly string[]).includes(resolution.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Notices can be re-sent only for a closed resolution.",
      });
    }
    const entry = resolution.snapshotId
      ? await ctx.db.recordSnapshotEntry.findUnique({
          where: {
            snapshotId_stakeholderId: {
              snapshotId: resolution.snapshotId,
              stakeholderId: input.stakeholderId,
            },
          },
          select: { id: true },
        })
      : null;
    if (!entry) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This person is not on the register of this resolution.",
      });
    }

    const kind: ResolutionNoticeJobData["kind"] =
      resolution.type === "PURCHASE_ORDER" ? "PO_COPY" : "RESULT";
    const events = await ctx.db.resolutionEvent.findMany({
      where: {
        resolutionId: resolution.id,
        dedupeKey: { startsWith: "notice:" },
      },
      select: { dedupeKey: true },
    });
    let maxSeq = 0;
    for (const { dedupeKey } of events) {
      const [, , stakeholderId, seq] = dedupeKey?.split(":") ?? [];
      if (stakeholderId !== input.stakeholderId) continue;
      const n = Number(seq);
      if (Number.isInteger(n) && n > maxSeq) maxSeq = n;
    }

    await emitResolutionNotices([
      {
        resolutionId: resolution.id,
        stakeholderId: input.stakeholderId,
        kind,
        seq: maxSeq + 1,
      },
    ]);
    return { success: true as const };
  });
