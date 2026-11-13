import { createTRPCRouter } from "@/trpc/api/trpc";
import { admitProcedure } from "./procedures/admit";
import { cancelProcedure } from "./procedures/cancel";
import { completeProcedure } from "./procedures/complete";
import { createProcedure } from "./procedures/create";
import { createNoticeCopyProcedure } from "./procedures/create-notice-copy";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { updateProcedure } from "./procedures/update";

// Unit transfers under Section 7 (03-governance.md G16). Every procedure is
// `withLlcAccessControl` with the `governance` RBAC subject; `companyId`
// always comes from the session's membership.
export const unitTransferRouter = createTRPCRouter({
  list: listProcedure,
  get: getProcedure,
  create: createProcedure,
  update: updateProcedure,
  createNoticeCopy: createNoticeCopyProcedure,
  complete: completeProcedure,
  admit: admitProcedure,
  cancel: cancelProcedure,
});
