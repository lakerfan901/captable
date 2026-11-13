import { TRPCError } from "@trpc/server";
import { emitResolutionFinalize } from "@/jobs/governance-resolution-finalize";
import { Audit } from "@/server/audit";
import { emitAfterCommit } from "@/server/governance/emit";
import { recordEvent } from "@/server/governance/events";
import { guardedWrite } from "@/server/governance/guarded";
import { loadEvaluation, lockResolution } from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionWithdrawSchema } from "../schema";
import { closeOverdue } from "./get";

// resolution.withdraw (03-governance.md G7): SENT -> WITHDRAWN (terminal,
// C3.4), under the resolution's row lock.
//
// Outstanding ballot links stop working for voting through the status gate,
// not through revocation: `ballot.submit` refuses any resolution that is not
// SENT (CLOSED), the ballot-email job sends nothing for it, and the G8
// reminder / link tools accept SENT only. The links are deliberately NOT
// revoked (tokenRevokedAt / tokenVersion unchanged): the plan's withdraw
// writes only status, closedAt and withdrawnReason, and `ballot.view` shows
// the "Withdrawn" page to the link holder (G11). The withdrawal notice sent by
// the finalize job goes to every ballot holder (invited or not) and carries
// no ballot link (G9, M2/L2).

const NOT_WITHDRAWABLE =
  "Only a sent resolution that is not yet effective can be withdrawn.";

export const withdrawProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionWithdrawSchema)
  .mutation(async ({ ctx, input }) => {
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
    // Lazy close first (A7): an overdue resolution keeps the result it
    // reached (EXPIRED, or FAILED with deemed votes under Section 2.5).
    if (
      found.status === "SENT" &&
      found.closesAt !== null &&
      found.closesAt.getTime() < now.getTime()
    ) {
      await closeOverdue(ctx.db, [found.id], now, "resolution.withdraw");
    }

    const resolutionId = await ctx.db.$transaction(async (tx) => {
      await lockResolution(tx, found.id);
      const resolution = await tx.resolution.findFirst({
        where: { id: found.id, companyId },
        select: {
          id: true,
          status: true,
          title: true,
          referenceCode: true,
          closesAt: true,
        },
      });
      if (!resolution) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resolution not found.",
        });
      }
      if (resolution.status !== "SENT") {
        throw new TRPCError({ code: "BAD_REQUEST", message: NOT_WITHDRAWABLE });
      }
      if (
        resolution.closesAt !== null &&
        now.getTime() > resolution.closesAt.getTime()
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "The response period for this resolution has ended; it can no longer be withdrawn.",
        });
      }

      // For-weight at close (schema: "when satisfied or when the resolution
      // closed"); write-once like the transitions in G6.
      const ev = await loadEvaluation(tx, resolution.id);

      const withdrawn = await guardedWrite(() =>
        tx.resolution.update({
          where: { id: resolution.id, companyId, status: "SENT" },
          data: {
            status: "WITHDRAWN",
            closedAt: now,
            withdrawnReason: input.reason,
          },
          select: { id: true },
        }),
      );
      if (!withdrawn) {
        throw new TRPCError({ code: "BAD_REQUEST", message: NOT_WITHDRAWABLE });
      }

      for (const [i, row] of ev.requirements.entries()) {
        if (row.kind !== "UNIT_VOTE") continue;
        const tally = ev.evaluation.results[i]?.tally;
        if (!tally || row.forUnitsAtClose !== null) continue;
        await guardedWrite(() =>
          tx.resolutionRequirement.update({
            where: {
              id: row.id,
              resolutionId: resolution.id,
              forUnitsAtClose: null,
            },
            data: { forUnitsAtClose: tally.for },
            select: { id: true },
          }),
        );
      }

      const ref = resolution.referenceCode ?? resolution.title;
      const userName = ctx.session.user.name ?? "A user";
      await recordEvent(tx, {
        resolutionId: resolution.id,
        companyId,
        type: "WITHDRAWN",
        actorType: "user",
        actorId: ctx.session.user.id,
        summary: `${userName} withdrew ${ref}. Reason: ${input.reason}`,
        ip: ctx.requestIp,
        userAgent: ctx.userAgent,
      });
      await Audit.create(
        {
          action: "resolution.withdrawn",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "resolution", id: resolution.id }],
          summary: `${userName} withdrew ${ref} "${resolution.title}". Reason: ${input.reason}`,
        },
        tx,
      );
      return resolution.id;
    });

    // After commit only: notifies every ballot holder (G9). A failed emit is
    // logged and recovered by the sweep (H2); the withdrawal stands.
    await emitAfterCommit("resolution finalize", { resolutionId }, () =>
      emitResolutionFinalize(resolutionId),
    );
    return { publicId: input.publicId, status: "WITHDRAWN" as const };
  });
