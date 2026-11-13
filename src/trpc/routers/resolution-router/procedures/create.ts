import { TRPCError } from "@trpc/server";
import { generatePublicId } from "@/common/id";
import {
  buildStarterBody,
  buildTitle,
  MATTERS,
  paramsSchema,
  type ResolutionType,
} from "@/lib/governance/presets";
import { Audit } from "@/server/audit";
import type { TPrismaOrTransaction } from "@/server/db";
import { termExtensionDraftFields } from "@/server/governance/term-extension";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionCreateSchema } from "../schema";

// resolution.create (03-governance.md G7). Also holds the draft helpers
// shared by update and clone.

/** Validates (and trims/defaults) params for `type`; BAD_REQUEST on failure. */
export function parseDraftParams(type: ResolutionType, params: unknown) {
  const parsed = paramsSchema(type).safeParse(params);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: parsed.error.issues
        .map((i) =>
          i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
        )
        .join("; "),
    });
  }
  return parsed.data as unknown;
}

/**
 * The `MATTERS` key a resolution decides: GENERAL_CONSENT stores the chosen
 * matter; the other types use the matter whose `presetType` is the type
 * (null for PURCHASE_ORDER, which is a Manager decision, not a Member matter).
 */
export function matterKeyFor(
  type: ResolutionType,
  params: unknown,
): string | null {
  if (type === "GENERAL_CONSENT") {
    return (params as { matterKey: string }).matterKey;
  }
  for (const [key, matter] of Object.entries(MATTERS)) {
    if (matter.presetType === type) return key;
  }
  return null;
}

/** AMENDMENT: every affected Member must be a stakeholder of the company. */
export async function assertDraftReferences(
  tx: TPrismaOrTransaction,
  companyId: string,
  type: ResolutionType,
  params: unknown,
): Promise<void> {
  if (type !== "AMENDMENT") return;
  const ids = (params as { affectedMemberIds: string[] }).affectedMemberIds;
  if (ids.length > 0) {
    await assertCompanyOwns(tx, companyId, { stakeholderIds: ids });
  }
}

/** BlockNote blocks (one text inline each) made from the preset starter body. */
export function starterBlocks(
  type: ResolutionType,
  params: unknown,
  companyName: string,
): unknown[] {
  return buildStarterBody(type, params, { companyName }).map((block) => ({
    type: block.type,
    props: block.type === "heading" ? { level: 2 } : {},
    content: [{ type: "text", text: block.text, styles: {} }],
    children: [],
  }));
}

export const createProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["create"] } } })
  .input(ZResolutionCreateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const type = input.type;
    let params = parseDraftParams(type, input.params);
    const companyName = ctx.company.name;

    return await ctx.db.$transaction(async (tx) => {
      await assertDraftReferences(tx, companyId, type, params);
      // A term extension's dates come from the term clock, never the input.
      if (type === "TERM_EXTENSION") {
        params = (await termExtensionDraftFields(tx, companyId)).params;
      }
      const title = buildTitle(type, params, { companyName }).slice(0, 200);
      const resolution = await tx.resolution.create({
        data: {
          publicId: generatePublicId(),
          companyId,
          type,
          status: "DRAFT",
          title,
          matterKey: matterKeyFor(type, params),
          params: params as object,
          body: starterBlocks(type, params, companyName) as object[],
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
          target: [{ type: "resolution", id: resolution.id }],
          summary: `${ctx.session.user.name ?? "A user"} created the draft resolution "${title}"`,
        },
        tx,
      );
      return { publicId: resolution.publicId };
    });
  });
