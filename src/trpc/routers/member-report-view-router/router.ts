import { createTRPCRouter } from "@/trpc/api/trpc";
import { attachmentUrlProcedure } from "./procedures/attachment-url";
import { markViewedProcedure } from "./procedures/mark-viewed";
import { requestSetupProcedure } from "./procedures/request-setup";
import { routeProcedure } from "./procedures/route";
import { viewProcedure } from "./procedures/view";

// Public member-report router (03-governance.md G12; 04-investor-portal.md
// P25). Every procedure is `withoutAuth` and goes through `resolveRecipient`
// (procedures/resolve.ts); the emailed token is the only credential and the
// only input that names a recipient. Every procedure is a mutation (POST
// body), so the token never appears in a URL. `route` and `requestSetup`
// keep these exact keys: the proxy's rate-limit buckets match on them
// (`token-api` and `account`, src/lib/rate-limit.ts).
export const memberReportViewRouter = createTRPCRouter({
  view: viewProcedure,
  markViewed: markViewedProcedure,
  attachmentUrl: attachmentUrlProcedure,
  route: routeProcedure,
  requestSetup: requestSetupProcedure,
});
