import { TRPCError } from "@trpc/server";
import type { ResolutionType } from "@/lib/governance/presets";
import { normalizeBlocks } from "@/lib/governance/rich-doc";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { lockResolution } from "@/server/governance/tally";
import { termExtensionDraftFields } from "@/server/governance/term-extension";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionUpdateSchema } from "../schema";
import {
  assertDraftReferences,
  matterKeyFor,
  parseDraftParams,
} from "./create";

// resolution.update (03-governance.md G7): DRAFT only (C3.4).
//
// Takes the resolution's row lock (the lock `resolution.send` holds for its
// whole transaction), re-reads the row and requires DRAFT AFTER the lock: an
// edit started while a send is in flight waits for it and is then refused, so
// it can never overwrite the title, params or body of a sent resolution. The
// write itself is a single-row guarded update as a backstop.

export const updateProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionUpdateSchema)
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
      let params = parseDraftParams(type, input.params);
      let title = input.title;
      // A term extension's dates and title come from the term clock (saving
      // a stale draft refreshes them), never from the input.
      if (type === "TERM_EXTENSION") {
        const canonical = await termExtensionDraftFields(tx, companyId);
        params = canonical.params;
        title = canonical.title;
      }
      const normalized = normalizeBlocks(input.body);
      if (!normalized.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: normalized.errors.join("; "),
        });
      }
      await assertDraftReferences(tx, companyId, type, params);

      // Backstop (the lock above already excludes a concurrent send).
      const updated = await guardedWrite(() =>
        tx.resolution.update({
          where: { id: existing.id, companyId, status: "DRAFT" },
          data: {
            title,
            params: params as object,
            body: input.body as object[],
            matterKey: matterKeyFor(type, params),
          },
          select: { id: true },
        }),
      );
      if (!updated) throw onlyDraft;

      await Audit.create(
        {
          action: "resolution.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "resolution", id: existing.id }],
          summary: `${ctx.session.user.name ?? "A user"} edited the draft resolution "${title}"`,
        },
        tx,
      );
      return {
        success: true as const,
        // What was stored when the server set it (TERM_EXTENSION).
        ...(type === "TERM_EXTENSION" ? { title, params } : {}),
      };
    });
  });
