import { createTRPCRouter } from "@/trpc/api/trpc";
import { approveProcedure } from "./procedures/approve";
import { cloneProcedure } from "./procedures/clone";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { optionsProcedure } from "./procedures/options";
import { previewProcedure } from "./procedures/preview";
import { resendNoticeProcedure } from "./procedures/resend-notice";
import { sendProcedure } from "./procedures/send";
import { updateProcedure } from "./procedures/update";
import { withdrawProcedure } from "./procedures/withdraw";

export const resolutionRouter = createTRPCRouter({
  list: listProcedure,
  get: getProcedure,
  options: optionsProcedure,
  preview: previewProcedure,
  create: createProcedure,
  update: updateProcedure,
  delete: deleteProcedure,
  clone: cloneProcedure,
  send: sendProcedure,
  approve: approveProcedure,
  withdraw: withdrawProcedure,
  resendNotice: resendNoticeProcedure,
});
