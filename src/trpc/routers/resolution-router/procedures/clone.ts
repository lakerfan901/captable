import { TRPCError } from "@trpc/server";
import { generatePublicId } from "@/common/id";
import { Audit } from "@/server/audit";
import { termExtensionDraftFields } from "@/server/governance/term-extension";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionCloneSchema } from "../schema";

// resolution.clone (03-governance.md G7): any status -> a new DRAFT with the
// same type, params, body and title ("Copy of " only when the source is a
// DRAFT). Params are copied as stored; `update` and `send` re-validate them.

export const cloneProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["create"] } } })
  .input(ZResolutionCloneSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    return await ctx.db.$transaction(async (tx) => {
      const source = await tx.resolution.findFirst({
        where: { publicId: input.publicId, companyId },
        select: {
          id: true,
          type: true,
          status: true,
          title: true,
          matterKey: true,
          params: true,
          body: true,
          referenceCode: true,
        },
      });
      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resolution not found.",
        });
      }
      let title = (
        source.status === "DRAFT" ? `Copy of ${source.title}` : source.title
      ).slice(0, 200);
      let params = source.params ?? {};
      // A term extension's dates and title come from the term clock now, not
      // from the copied consent (which asked about an earlier date).
      if (source.type === "TERM_EXTENSION") {
        const canonical = await termExtensionDraftFields(tx, companyId);
        params = { ...canonical.params };
        title = canonical.title;
      }
      const created = await tx.resolution.create({
        data: {
          publicId: generatePublicId(),
          companyId,
          type: source.type,
          status: "DRAFT",
          title,
          matterKey: source.matterKey,
          params,
          body: source.body ?? [],
          clonedFromId: source.id,
          authorId: ctx.membership.memberId,
        },
        select: { id: true, publicId: true },
      });
      await Audit.create(
        {
          action: "resolution.created",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "resolution", id: created.id }],
          summary: `${ctx.session.user.name ?? "A user"} created the draft resolution "${title}" as a copy of ${source.referenceCode ?? `"${source.title}"`}`,
        },
        tx,
      );
      return { publicId: created.publicId };
    });
  });
