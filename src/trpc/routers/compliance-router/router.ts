import { createTRPCRouter } from "@/trpc/api/trpc";
import { completeProcedure } from "./procedures/complete";
import { createCustomProcedure } from "./procedures/create-custom";
import { listProcedure } from "./procedures/list";
import { markNotApplicableProcedure } from "./procedures/not-applicable";
import { reopenProcedure } from "./procedures/reopen";
import { updateProcedure } from "./procedures/update";

// Compliance calendar (03-governance.md G14). Every procedure is
// `withLlcAccessControl` with the `governance` RBAC subject; `companyId`
// always comes from the session's membership.
export const complianceRouter = createTRPCRouter({
  list: listProcedure,
  createCustom: createCustomProcedure,
  update: updateProcedure,
  complete: completeProcedure,
  reopen: reopenProcedure,
  markNotApplicable: markNotApplicableProcedure,
});
