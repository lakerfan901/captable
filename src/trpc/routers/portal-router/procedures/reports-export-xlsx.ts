// portal.reports.exportXlsx (04-investor-portal.md 5.4, 5.9).
// P0 stub: package P7 replaces this file; router.ts stays as it is.
// The base is `withoutAuth` until P2 replaces it with the portal procedure
// base (`src/trpc/api/portal-procedure.ts`). A stub reads nothing.

import { TRPCError } from "@trpc/server";
import { withoutAuth } from "@/trpc/api/trpc";

export const reportsExportXlsxProcedure = withoutAuth.mutation(() => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "portal.reports.exportXlsx is not implemented yet.",
  });
});
