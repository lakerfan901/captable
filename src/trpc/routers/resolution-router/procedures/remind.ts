import { TRPCError } from "@trpc/server";
import {
  type BallotEmailJobData,
  emitBallotEmails,
} from "@/jobs/governance-ballot-email";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionRemindSchema } from "../schema";

// resolution.remind (03-governance.md G8): emails a reminder to the open
// ballots of a SENT resolution. No write here: the email job records the
// REMINDER_EMAILED event, bumps reminderCount and writes `ballot.reminded`.
//
// Recovery path: a ballot that was never invited (send committed but its
// invite job was lost) gets its INVITE (seq 0, the key send uses) instead of
// a reminder, so the job also sets `invitedAt`.

const REMINDER_GAP_MS = 24 * 60 * 60 * 1000;

export const remindProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionRemindSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();

    const resolution = await ctx.db.resolution.findFirst({
      where: { publicId: input.publicId, companyId },
      select: { id: true, status: true, closesAt: true },
    });
    if (!resolution) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Resolution not found.",
      });
    }
    if (
      resolution.status !== "SENT" ||
      (resolution.closesAt !== null &&
        resolution.closesAt.getTime() <= now.getTime())
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Reminders can be sent only while the vote is open.",
      });
    }

    const wanted = input.ballotIds ? [...new Set(input.ballotIds)] : null;
    const ballots = await ctx.db.resolutionBallot.findMany({
      where: {
        resolutionId: resolution.id,
        companyId,
        ...(wanted ? { id: { in: wanted } } : {}),
      },
      select: {
        id: true,
        submittedAt: true,
        tokenRevokedAt: true,
        invitedAt: true,
        lastReminderAt: true,
        reminderCount: true,
      },
    });
    if (wanted && ballots.length !== wanted.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Ballot not found.",
      });
    }

    const items: BallotEmailJobData[] = [];
    let skipped = 0;
    for (const b of ballots) {
      if (b.submittedAt !== null || b.tokenRevokedAt !== null) {
        skipped++;
        continue;
      }
      if (b.invitedAt === null) {
        items.push({ ballotId: b.id, kind: "INVITE", seq: 0 });
        continue;
      }
      if (
        b.lastReminderAt !== null &&
        now.getTime() - b.lastReminderAt.getTime() < REMINDER_GAP_MS
      ) {
        skipped++;
        continue;
      }
      items.push({
        ballotId: b.id,
        kind: "REMINDER",
        seq: b.reminderCount + 1,
      });
    }

    await emitBallotEmails(items);
    return { sent: items.length, skipped };
  });
