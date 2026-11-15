// portalAdmin.holderView (04-investor-portal.md 5.6).
// P0 stub: package P9b replaces this file; router.ts stays as it is.
import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const holderViewProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["read"] } } })
  .query(() => {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "portalAdmin.holderView is not implemented yet.",
    });
  });
