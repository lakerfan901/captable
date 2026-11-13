import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { lockResolution } from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionDeleteSchema } from "../schema";

// resolution.delete (03-governance.md G7): DRAFT only, hard delete (C3.4).
//
// Row lock first (as `resolution.send`), re-read, require DRAFT, then ONE
// single-row guarded `delete` (`WHERE id AND status = 'DRAFT'`). Never a
// guarded `deleteMany`: with emulated cascades Prisma deletes the children by
// stale ids before the guarded parent DELETE (see server/governance/guarded.ts).

export const deleteProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["delete"] } } })
  .input(ZResolutionDeleteSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    return await ctx.db.$transaction(async (tx) => {
      const found = await tx.resolution.findFirst({
        where: { publicId: input.publicId, companyId },
        select: { id: true },
      });
      if (!found) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resolution not found.",
        });
      }
      await lockResolution(tx, found.id);
      const existing = await tx.resolution.findFirst({
        where: { id: found.id, companyId },
        select: { id: true, status: true, title: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resolution not found.",
        });
      }
      const onlyDraft = new TRPCError({
        code: "BAD_REQUEST",
        message: "Only a draft can be deleted.",
      });
      if (existing.status !== "DRAFT") throw onlyDraft;
      // Guarded so a resolution sent concurrently is never deleted. A draft
      // has no ballots, events or snapshot.
      const deleted = await guardedWrite(() =>
        tx.resolution.delete({
          where: { id: existing.id, companyId, status: "DRAFT" },
          select: { id: true },
        }),
      );
      if (!deleted) throw onlyDraft;
      await Audit.create(
        {
          action: "resolution.deleted",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "resolution", id: existing.id }],
          summary: `${ctx.session.user.name ?? "A user"} deleted the draft resolution "${existing.title}"`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
