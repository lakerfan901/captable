import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionOptionsSchema } from "../schema";

// resolution.options (03-governance.md G7): picker rows for other areas
// (ECONOMICS links payments, loans and term extensions to a resolution).

export const optionsProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZResolutionOptionsSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    return await ctx.db.resolution.findMany({
      where: {
        companyId,
        status: { in: input.statuses },
        ...(input.types ? { type: { in: input.types } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      select: {
        id: true,
        publicId: true,
        referenceCode: true,
        title: true,
        type: true,
        matterKey: true,
        status: true,
        effectiveAt: true,
      },
    });
  });
