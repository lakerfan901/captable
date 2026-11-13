import { createTRPCRouter } from "@/trpc/api/trpc";
import { cloneProcedure } from "./procedures/clone";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { optionsProcedure } from "./procedures/options";
import { previewProcedure } from "./procedures/preview";
import { resendNoticeProcedure } from "./procedures/resend-notice";
import { updateProcedure } from "./procedures/update";

export const resolutionRouter = createTRPCRouter({
  list: listProcedure,
  get: getProcedure,
  options: optionsProcedure,
  preview: previewProcedure,
  create: createProcedure,
  update: updateProcedure,
  delete: deleteProcedure,
  clone: cloneProcedure,
  resendNotice: resendNoticeProcedure,
});
