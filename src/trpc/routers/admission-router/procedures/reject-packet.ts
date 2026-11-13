import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { decideCommitment, type LedgerActor } from "@/server/llc/commitments";
import { actorFrom } from "@/server/llc/economics/scope";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { loadPacketView, lockPacket, wrongStage } from "../packet";
import { ZodRejectPacketSchema } from "../schema";

/**
 * admission.reject (F13), inside the caller's transaction: the same
 * `decideCommitment(REJECT)` the Commitments page uses (`commitment.reject`),
 * which records the refund due and cancels the packet.
 */
export async function rejectPacket(
  tx: PrismaTransactionalClient,
  companyId: string,
  input: z.infer<typeof ZodRejectPacketSchema>,
  actor: LedgerActor,
): Promise<{ commitmentId: string }> {
  const { packet, stage } = await lockPacket(tx, companyId, input.publicId, {
    ledger: true,
  });
  if (stage !== "AWAITING_REVIEW" || packet.commitmentId === null) {
    throw wrongStage(
      stage === "AWAITING_REVIEW"
        ? "Save the details first; a subscription without a commitment is cancelled, not rejected."
        : "Only a subscription waiting for the decision can be rejected.",
      stage,
    );
  }

  await decideCommitment(
    tx,
    {
      companyId,
      commitmentId: packet.commitmentId,
      decision: "REJECT",
      acceptedOn: input.decidedOn,
      rejectionReason: input.reason,
    },
    actor,
  );

  const after = await tx.template.findFirst({
    where: { id: packet.id, companyId },
    select: { status: true },
  });
  if (after?.status !== "CANCELLED") {
    // decideCommitment cancels the PENDING packet; we hold its lock.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The subscription could not be cancelled.",
    });
  }

  await Audit.create(
    {
      action: "admission.cancelled",
      companyId,
      actor: { type: "user", id: actor.userId },
      context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
      target: [
        { type: "template", id: packet.id },
        { type: "commitment", id: packet.commitmentId },
      ],
      summary: `${actor.name} rejected the subscription "${packet.name}" on ${input.decidedOn}; the packet was cancelled.`,
    },
    tx,
  );
  return { commitmentId: packet.commitmentId };
}

export const rejectPacketProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["update"] } } })
  .input(ZodRejectPacketSchema)
  .mutation(({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const actor = actorFrom(ctx);
    return ctx.db.$transaction(async (tx) => {
      await rejectPacket(tx, companyId, input, actor);
      return loadPacketView(
        tx,
        ctx.company,
        input.publicId,
        ctx.membership.memberId,
      );
    });
  });
