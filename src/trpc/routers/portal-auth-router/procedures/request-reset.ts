// portalAuth.requestReset (04-investor-portal.md 5.2, 5.4).
// P0 stub: package P2a replaces this file; router.ts stays as it is.
// The base is `withoutAuth` until P2 replaces it with the portal procedure
// base (`src/trpc/api/portal-procedure.ts`). A stub reads nothing.

import { TRPCError } from "@trpc/server";
import { withoutAuth } from "@/trpc/api/trpc";

export const requestResetProcedure = withoutAuth.mutation(() => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "portalAuth.requestReset is not implemented yet.",
  });
});
