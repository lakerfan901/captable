import { createTRPCRouter } from "@/trpc/api/trpc";
import { attachmentUrlProcedure } from "./procedures/attachment-url";
import { markViewedProcedure } from "./procedures/mark-viewed";
import { viewProcedure } from "./procedures/view";

// Public member-report router (03-governance.md G12). Every procedure is
// `withoutAuth` and goes through `resolveRecipient` (procedures/resolve.ts);
// the emailed token is the only credential and the only input that names a
// recipient. Every procedure is a mutation (POST body), so the token never
// appears in a URL.
export const memberReportViewRouter = createTRPCRouter({
  view: viewProcedure,
  markViewed: markViewedProcedure,
  attachmentUrl: attachmentUrlProcedure,
});
