// portalAdmin.unshareDocument (04-investor-portal.md 5.6).
// P0 stub: package P6 replaces this file; router.ts stays as it is.
import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const unshareDocumentProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["delete"] } } })
  .mutation(() => {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "portalAdmin.unshareDocument is not implemented yet.",
    });
  });
