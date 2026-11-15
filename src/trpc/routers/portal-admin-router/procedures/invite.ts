// portalAdmin.invite (04-investor-portal.md 5.6).
// P0 stub: package P3 replaces this file; router.ts stays as it is.
import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const inviteProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["create"] } } })
  .mutation(() => {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "portalAdmin.invite is not implemented yet.",
    });
  });
