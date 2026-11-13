import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import type { LedgerActor } from "@/server/llc/commitments";
import { actorFrom } from "@/server/llc/economics/scope";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import {
  MANAGER_ALREADY_SIGNED,
  replaceManagerRecipient,
} from "../countersign";
import { loadPacketView, lockPacket, wrongStage } from "../packet";
import { ZodReassignManagerSchema } from "../schema";

export { MANAGER_ALREADY_SIGNED };

/**
 * admission.reassignManager (F13), inside the caller's transaction: another
 * active team member becomes the packet's Manager signer while the Manager
 * has not signed. The Manager recipient row is replaced (new id, PENDING,
 * the Manager's fields moved to it), so a countersign link handed out
 * earlier names a row that no longer exists and never works again.
 */
export async function reassignPacketManager(
  tx: PrismaTransactionalClient,
  companyId: string,
  input: z.infer<typeof ZodReassignManagerSchema>,
  actor: LedgerActor,
): Promise<void> {
  const { packet, stage, manager } = await lockPacket(
    tx,
    companyId,
    input.publicId,
    { ledger: false },
  );
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

  await replaceManagerRecipient(tx, {
    templateId: packet.id,
    old: manager,
    next: { memberId: member.id, name, email, status: "PENDING" },
  });

  await Audit.create(
    {
      action: "admission.manager-reassigned",
      companyId,
      actor: { type: "user", id: actor.userId },
      context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
      target: [{ type: "template", id: packet.id }],
      summary: `${actor.name} changed the Manager signer of "${packet.name}" from ${manager.name ?? "(none)"} to ${name}${
        manager.status === "SENT"
          ? "; the earlier countersign link no longer works"
          : ""
      }.`,
    },
    tx,
  );
}

export const reassignManagerProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["update"] } } })
  .input(ZodReassignManagerSchema)
  .mutation(({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    return ctx.db.$transaction(async (tx) => {
      await reassignPacketManager(tx, companyId, input, actorFrom(ctx));
      return loadPacketView(
        tx,
        ctx.company,
        input.publicId,
        ctx.membership.memberId,
      );
    });
  });
