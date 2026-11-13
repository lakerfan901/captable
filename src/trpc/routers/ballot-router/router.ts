import { createTRPCRouter } from "@/trpc/api/trpc";
import { executedPdfProcedure } from "./procedures/executed-pdf";
import { markViewedProcedure } from "./procedures/mark-viewed";
import { submitProcedure } from "./procedures/submit";
import { viewProcedure } from "./procedures/view";

// Public ballot router (03-governance.md G8). Every procedure is
// `withoutAuth` and goes through `resolveBallot` (procedures/resolve.ts);
// the emailed token is the only credential and the only input that names a
// ballot. Every procedure is a mutation (POST body), so the token never
// appears in a URL.
export const ballotRouter = createTRPCRouter({
  view: viewProcedure,
  markViewed: markViewedProcedure,
  submit: submitProcedure,
  executedPdf: executedPdfProcedure,
});
