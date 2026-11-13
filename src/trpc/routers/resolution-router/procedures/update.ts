import { TRPCError } from "@trpc/server";
import type { ResolutionType } from "@/lib/governance/presets";
import { normalizeBlocks } from "@/lib/governance/rich-doc";
import { Audit } from "@/server/audit";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionUpdateSchema } from "../schema";
import {
  assertDraftReferences,
  matterKeyFor,
  parseDraftParams,
} from "./create";

// resolution.update (03-governance.md G7): DRAFT only (C3.4).

export const updateProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionUpdateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const existing = await tx.resolution.findFirst({
        where: { publicId: input.publicId, companyId },
        select: { id: true, type: true, status: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resolution not found.",
        });
      }
      const onlyDraft = new TRPCError({
        code: "BAD_REQUEST",
        message: "Only a draft can be edited.",
      });
      if (existing.status !== "DRAFT") throw onlyDraft;

      const type = existing.type as ResolutionType;
      const params = parseDraftParams(type, input.params);
      const normalized = normalizeBlocks(input.body);
      if (!normalized.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: normalized.errors.join("; "),
        });
      }
      await assertDraftReferences(tx, companyId, type, params);

      // Guarded write: a concurrent send moves the row out of DRAFT.
      const { count } = await tx.resolution.updateMany({
        where: { id: existing.id, companyId, status: "DRAFT" },
        data: {
          title: input.title,
          params: params as object,
          body: input.body as object[],
          matterKey: matterKeyFor(type, params),
        },
      });
      if (count !== 1) throw onlyDraft;

      await Audit.create(
        {
          action: "resolution.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "resolution", id: existing.id }],
          summary: `${ctx.session.user.name ?? "A user"} edited the draft resolution "${input.title}"`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
