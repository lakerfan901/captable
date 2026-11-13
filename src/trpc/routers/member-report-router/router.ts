import { createTRPCRouter } from "@/trpc/api/trpc";
import { addAttachmentProcedure } from "./procedures/add-attachment";
import { attachmentUrlProcedure } from "./procedures/attachment-url";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { refreshFiguresProcedure } from "./procedures/refresh-figures";
import { removeAttachmentProcedure } from "./procedures/remove-attachment";
import { replaceLinkProcedure } from "./procedures/replace-link";
import { resendProcedure } from "./procedures/resend";
import { sendProcedure } from "./procedures/send";
import { updateProcedure } from "./procedures/update";

// Manager procedures for member reports (03-governance.md G12). Every
// procedure is `withLlcAccessControl` with the `governance` RBAC subject;
// `companyId` always comes from the session's membership.
export const memberReportRouter = createTRPCRouter({
  list: listProcedure,
  get: getProcedure,
  create: createProcedure,
  refreshFigures: refreshFiguresProcedure,
  update: updateProcedure,
  addAttachment: addAttachmentProcedure,
  removeAttachment: removeAttachmentProcedure,
  attachmentUrl: attachmentUrlProcedure,
  delete: deleteProcedure,
  send: sendProcedure,
  resend: resendProcedure,
  replaceLink: replaceLinkProcedure,
});
