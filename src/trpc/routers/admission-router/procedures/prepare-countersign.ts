import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import type { LedgerActor } from "@/server/llc/commitments";
import { actorFrom } from "@/server/llc/economics/scope";
import { dateToWire, trimUnits } from "@/server/llc/serialize";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { EncodeEmailToken } from "@/trpc/routers/template-field-router/procedures/add-fields";
import { ledgerFigures, lockPacket, wrongStage } from "../packet";
import { ZodPrepareCountersignSchema } from "../schema";

const LEDGER_KEYS = ["contribution_received", "units_issued"] as const;

/**
 * admission.prepareCountersign (F13, B23), inside the caller's transaction:
 * writes the ledger figures on the Manager's Exhibit B lines and activates
 * the Manager's signing link. The two ledger lines are set read-only, which
 * is what keeps the Manager's own submitted values from replacing them
 * (`filterSignerValues`); the date line is prefilled with the acceptance
 * date and stays editable. The figures are recomputed here and must equal
 * the ones the Manager saw (`expected…`), else CONFLICT.
 */
export async function preparePacketCountersign(
  tx: PrismaTransactionalClient,
  companyId: string,
  input: z.infer<typeof ZodPrepareCountersignSchema>,
  actor: LedgerActor,
): Promise<{ templateId: string; recipientId: string }> {
  const { packet, stage, manager } = await lockPacket(
    tx,
    companyId,
    input.publicId,
    { ledger: true },
  );
  if (stage !== "AWAITING_COUNTERSIGN" || packet.commitmentId === null) {
    throw wrongStage(
      "The countersignature is prepared after the subscription is accepted.",
      stage,
    );
  }
  if (!manager) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This subscription has no Manager signer.",
    });
  }
  if (manager.memberId === null || manager.memberId !== actor.memberId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Only ${manager.name ?? "the designated signer"} can countersign this packet. Reassign the signer first.`,
    });
  }

  const commitment = await tx.commitment.findFirst({
    where: { id: packet.commitmentId, companyId },
    select: { id: true, status: true, acceptedOn: true },
  });
  if (
    !commitment ||
    (commitment.status !== "ACCEPTED" && commitment.status !== "REDUCED")
  ) {
    throw wrongStage(
      "The countersignature is prepared after the subscription is accepted.",
      stage,
    );
  }

  const { receivedCents, units } = await ledgerFigures(
    tx,
    companyId,
    commitment.id,
  );
  if (
    receivedCents !== BigInt(input.expectedReceivedCents) ||
    trimUnits(units) !== trimUnits(input.expectedUnits)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `The ledger now shows ${formatCents(receivedCents)} received and ${trimUnits(units)} Preferred Units issued, not ${formatCents(input.expectedReceivedCents)} and ${trimUnits(input.expectedUnits)}. Reload the page and check the figures.`,
    });
  }

  const fields = await tx.templateField.findMany({
    where: {
      templateId: packet.id,
      recipientId: manager.id,
      semanticKey: { in: [...LEDGER_KEYS, "manager_sign_date"] },
    },
    select: { id: true, semanticKey: true },
  });
  for (const key of LEDGER_KEYS) {
    if (!fields.some((f) => f.semanticKey === key)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `The packet has no Manager field for "${key}". Fix the master and send a new subscription.`,
      });
    }
  }
  const acceptedOn = dateToWire(commitment.acceptedOn);
  const valueFor: Record<string, string | null> = {
    contribution_received: formatCents(receivedCents),
    units_issued: trimUnits(units),
    manager_sign_date: acceptedOn,
  };
  for (const field of fields) {
    const key = field.semanticKey ?? "";
    await tx.templateField.update({
      where: { id: field.id },
      data: {
        prefilledValue: valueFor[key] ?? null,
        ...(key === "manager_sign_date" ? {} : { readOnly: true }),
      },
    });
  }

  const activated = await guardedUpdate(() =>
    tx.esignRecipient.update({
      where: { id: manager.id, status: { in: ["PENDING", "SENT"] } },
      data: { status: "SENT" },
      select: { id: true },
    }),
  );
  if (activated === null) {
    throw wrongStage("The Manager has already countersigned.", "FINALISING");
  }

  await Audit.create(
    {
      action: "admission.countersign-ready",
      companyId,
      actor: { type: "user", id: actor.userId },
      context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
      target: [
        { type: "template", id: packet.id },
        { type: "commitment", id: commitment.id },
      ],
      summary: `${actor.name} prepared the countersignature of "${packet.name}": Capital Contribution received ${formatCents(receivedCents)}, Preferred Units issued ${trimUnits(units)}${
        acceptedOn ? `, dated ${acceptedOn}` : ""
      }.`,
    },
    tx,
  );
  return { templateId: packet.id, recipientId: manager.id };
}

export const prepareCountersignProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["update"] } } })
  .input(ZodPrepareCountersignSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const actor = actorFrom(ctx);
    const ids = await ctx.db.$transaction((tx) =>
      preparePacketCountersign(tx, companyId, input, actor),
    );
    return { token: await EncodeEmailToken(ids) };
  });
