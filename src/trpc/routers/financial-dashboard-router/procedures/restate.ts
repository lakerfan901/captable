// financialDashboard.restate (04-investor-portal.md 5.9).
// P0 stub: package P13b replaces this file; router.ts stays as it is.
import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const restateProcedure = withLlcAccessControl
  .meta({
    policies: {
      "llc-financials": { allow: ["update"] },
      governance: { allow: ["update"] },
    },
  })
  .mutation(() => {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "financialDashboard.restate is not implemented yet.",
    });
  });
