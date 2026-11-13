import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { closeSourceDeadlines } from "@/server/governance/compliance";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferCancelSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadLockedTransfer,
  userName,
} from "./shared";

// unitTransfer.cancel (03-governance.md G16): OPEN → CANCELLED (terminal,
// C3.8). Row lock, re-read, then one single-row guarded update. Its open
// deadlines are closed as NOT_APPLICABLE ("Transfer cancelled"), except the
// TRANSFER_NOTICE_COPY deadline: the copy of a notice already received is
// still owed to the other Preferred Members (7.1, 7.2).

export const cancelProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZUnitTransferCancelSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadLockedTransfer(tx, companyId, input.publicId);
      const onlyOpen = "Only an open transfer can be cancelled.";
      if (row.status !== "OPEN") badRequest(onlyOpen);

      const cancelled = await guardedWrite(() =>
        tx.unitTransfer.update({
          where: { id: row.id, companyId, status: "OPEN" },
          data: {
            status: "CANCELLED",
            cancelledAt: now,
            cancelReason: input.reason,
          },
          select: { id: true },
        }),
      );
      if (!cancelled) {
        throw new TRPCError({ code: "CONFLICT", message: onlyOpen });
      }

      await closeSourceDeadlines(tx, {
        companyId,
        sourceType: "UNIT_TRANSFER",
        sourceId: row.id,
        status: "NOT_APPLICABLE",
        note: "Transfer cancelled",
        exceptRuleKeys: ["TRANSFER_NOTICE_COPY"],
        completedById: ctx.membership.memberId,
        now,
      });

      await Audit.create(
        {
          action: "unitTransfer.cancelled",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "unitTransfer", id: row.id }],
          summary: `${userName(ctx)} cancelled a unit transfer: ${input.reason}`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
