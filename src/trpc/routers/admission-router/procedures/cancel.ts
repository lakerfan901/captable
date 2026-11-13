import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { guardedUpdate } from "@/server/guarded-write";
import {
  lockTemplate,
  packetStageOf,
  packetStageSelect,
} from "@/server/llc/admission";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZodPacketPublicIdSchema } from "../schema";

// admission.cancel (F12): only before the Manager has anything to decide —
// stage AWAITING_INVESTOR, or AWAITING_REVIEW without a commitment. Once a
// commitment exists the packet ends through `admission.reject` (F13).
//
// The template row lock (shared with `template.sign`) makes "the investor
// signs" and "the Manager cancels" happen one after the other; the guarded
// single-row update re-checks status and commitment on the UPDATE itself.
export const cancelProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["update"] } } })
  .input(ZodPacketPublicIdSchema)
  .mutation(({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const user = ctx.session.user;
    const notCancellable = () =>
      new TRPCError({
        code: "BAD_REQUEST",
        message:
          "This subscription can no longer be cancelled. Reject it from the review screen instead.",
      });

    return ctx.db.$transaction(async (tx) => {
      const found = await tx.template.findFirst({
        where: {
          publicId: input.publicId,
          companyId,
          workflow: "SUBSCRIPTION",
          isMaster: false,
        },
        select: { id: true },
      });
      if (!found) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found.",
        });
      }
      await lockTemplate(tx, found.id);
      const packet = await tx.template.findFirstOrThrow({
        where: { id: found.id, companyId },
        select: {
          ...packetStageSelect,
          id: true,
          name: true,
          commitmentId: true,
        },
      });
      const stage = packetStageOf(packet);
      const allowed =
        packet.commitmentId === null &&
        (stage === "AWAITING_INVESTOR" || stage === "AWAITING_REVIEW");
      if (!allowed) throw notCancellable();

      const cancelled = await guardedUpdate(() =>
        tx.template.update({
          where: {
            id: packet.id,
            companyId,
            status: "PENDING",
            AND: [{ commitmentId: null }],
          },
          data: { status: "CANCELLED" },
          select: { id: true },
        }),
      );
      if (cancelled === null) throw notCancellable();

      await Audit.create(
        {
          action: "admission.cancelled",
          companyId,
          actor: { type: "user", id: user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "template", id: packet.id }],
          summary: `${user.name ?? "A team member"} cancelled the subscription "${packet.name}"`,
        },
        tx,
      );
      return { ok: true as const };
    });
  });
