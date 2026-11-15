// portalAdmin.shareDocuments (04-investor-portal.md 5.6).
// P0 stub: package P6 replaces this file; router.ts stays as it is.
import { TRPCError } from "@trpc/server";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const shareDocumentsProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["create"] } } })
  .mutation(() => {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "portalAdmin.shareDocuments is not implemented yet.",
    });
  });
