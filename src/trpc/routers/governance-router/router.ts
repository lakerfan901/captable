import { createTRPCRouter } from "@/trpc/api/trpc";
import { memberActivityProcedure } from "./procedures/member-activity";

// Governance queries that span resolutions, reports and transfers
// (03-governance.md G19).
export const governanceRouter = createTRPCRouter({
  memberActivity: memberActivityProcedure,
});
