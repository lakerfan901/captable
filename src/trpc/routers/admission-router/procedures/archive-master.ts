import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { guardedUpdate } from "@/server/guarded-write";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZodPacketPublicIdSchema } from "../schema";

// admission.archiveMaster (F12): the master becomes CANCELLED and leaves the
// masters list; packets cloned from it are unaffected (they have their own
// recipients and fields).
export const archiveMasterProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["delete"] } } })
  .input(ZodPacketPublicIdSchema)
  .mutation(({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const user = ctx.session.user;
    const alreadyArchived = () =>
      new TRPCError({
        code: "BAD_REQUEST",
        message: "This master is already archived.",
      });

    return ctx.db.$transaction(async (tx) => {
      const master = await tx.template.findFirst({
        where: {
          publicId: input.publicId,
          companyId,
          isMaster: true,
          workflow: "SUBSCRIPTION",
        },
        select: { id: true, name: true, status: true },
      });
      if (!master) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Master not found.",
        });
      }
      if (master.status !== "DRAFT") throw alreadyArchived();

      const archived = await guardedUpdate(() =>
        tx.template.update({
          where: { id: master.id, companyId, isMaster: true, status: "DRAFT" },
          data: { status: "CANCELLED" },
          select: { id: true },
        }),
      );
      if (archived === null) throw alreadyArchived();

      await Audit.create(
        {
          action: "admission.master-archived",
          companyId,
          actor: { type: "user", id: user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "template", id: master.id }],
          summary: `${user.name ?? "A team member"} archived the subscription master "${master.name}"`,
        },
        tx,
      );
      return { ok: true as const };
    });
  });
