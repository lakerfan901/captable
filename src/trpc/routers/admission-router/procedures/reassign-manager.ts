import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import type { PrismaTransactionalClient } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { loadPacketView, lockPacket, wrongStage } from "../packet";
import { ZodReassignManagerSchema } from "../schema";

export const MANAGER_ALREADY_SIGNED =
  "The Manager has already countersigned; the signer can no longer be changed.";

/**
 * admission.reassignManager (F13), inside the caller's transaction: another
 * active team member becomes the packet's Manager signer while the Manager
 * has not signed. The recipient goes back to PENDING, so a countersign link
 * handed out earlier stops working until `prepareCountersign` runs again.
 */
export async function reassignPacketManager(
  tx: PrismaTransactionalClient,
  companyId: string,
  input: z.infer<typeof ZodReassignManagerSchema>,
): Promise<void> {
  const { stage, manager } = await lockPacket(tx, companyId, input.publicId, {
    ledger: false,
  });
  if (
    stage !== "AWAITING_INVESTOR" &&
    stage !== "AWAITING_REVIEW" &&
    stage !== "AWAITING_COUNTERSIGN"
  ) {
    throw wrongStage("The signer can no longer be changed.", stage);
  }
  if (!manager) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This subscription has no Manager signer.",
    });
  }
  if (manager.status === "SIGNED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: MANAGER_ALREADY_SIGNED,
    });
  }

  const member = await tx.member.findFirst({
    where: { id: input.managerMemberId, companyId, status: "ACTIVE" },
    select: { id: true, user: { select: { name: true, email: true } } },
  });
  if (!member) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Manager signer not found.",
    });
  }
  const name = member.user.name?.trim();
  const email = member.user.email?.trim();
  if (!name || !email) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The Manager signer needs a name and an email in their profile.",
    });
  }

  const updated = await guardedUpdate(() =>
    tx.esignRecipient.update({
      where: { id: manager.id, status: { in: ["PENDING", "SENT"] } },
      data: { memberId: member.id, name, email, status: "PENDING" },
      select: { id: true },
    }),
  );
  if (updated === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: MANAGER_ALREADY_SIGNED,
    });
  }
}

export const reassignManagerProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["update"] } } })
  .input(ZodReassignManagerSchema)
  .mutation(({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    return ctx.db.$transaction(async (tx) => {
      await reassignPacketManager(tx, companyId, input);
      return loadPacketView(
        tx,
        ctx.company,
        input.publicId,
        ctx.membership.memberId,
      );
    });
  });
