// portal.findReport (04-investor-portal.md 5.4, 5.9).
// P0 stub: package P5a replaces this file; router.ts stays as it is.
// P2a set the base to `portalSessionProcedure` (src/trpc/api/portal-procedure.ts), so
// even the stub requires a portal session. A stub reads nothing.

import { TRPCError } from "@trpc/server";
import { portalSessionProcedure } from "@/trpc/api/portal-procedure";

export const findReportProcedure = portalSessionProcedure.query(() => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "portal.findReport is not implemented yet.",
  });
});
