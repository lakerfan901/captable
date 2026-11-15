// financialDashboard.exportXlsx (04-investor-portal.md 5.9).
// P0 stub: package P17 replaces this file; router.ts stays as it is.
import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const exportXlsxProcedure = withLlcAccessControl
  .meta({ policies: { "llc-financials": { allow: ["read"] } } })
  .mutation(() => {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "financialDashboard.exportXlsx is not implemented yet.",
    });
  });
