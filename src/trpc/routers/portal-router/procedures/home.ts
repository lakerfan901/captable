// portal.home (04-investor-portal.md 5.4, 5.9).
// P0 stub: package P8b replaces this file; router.ts stays as it is.
// P2a set the base to `investorProcedure` (src/trpc/api/portal-procedure.ts), so
// even the stub requires a portal session and a resolved holder. A stub reads nothing.

import { TRPCError } from "@trpc/server";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export const homeProcedure = investorProcedure.query(() => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "portal.home is not implemented yet.",
  });
});
