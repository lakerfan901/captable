import { createTRPCRouter } from "@/trpc/api/trpc";
import { addAttachmentProcedure } from "./procedures/add-attachment";
import { addRecipientsProcedure } from "./procedures/add-recipients";
import { attachmentUrlProcedure } from "./procedures/attachment-url";
import { audienceOptionsProcedure } from "./procedures/audience-options";
import { createProcedure } from "./procedures/create";
import { deleteProcedure } from "./procedures/delete";
import { exportXlsxProcedure } from "./procedures/export-xlsx";
import { getProcedure } from "./procedures/get";
import { listProcedure } from "./procedures/list";
import { publishProcedure } from "./procedures/publish";
import { reconcileProcedure } from "./procedures/reconcile";
import { refreshFiguresProcedure } from "./procedures/refresh-figures";
import { releaseProcedure } from "./procedures/release";
import { removeAttachmentProcedure } from "./procedures/remove-attachment";
import { removeRecipientProcedure } from "./procedures/remove-recipient";
import { replaceLinkProcedure } from "./procedures/replace-link";
import { resendProcedure } from "./procedures/resend";
import { unpublishProcedure } from "./procedures/unpublish";
import { updateProcedure } from "./procedures/update";

// Manager procedures for member reports (03-governance.md G12;
// 04-investor-portal.md 5.5). Every procedure is `withLlcAccessControl` with
// the `governance` RBAC subject; `companyId` always comes from the session's
// membership. `send` was replaced by `release` (P4a); its last caller, the
// review dialog, was replaced by the release dialog (P4c), and it was removed.
export const memberReportRouter = createTRPCRouter({
  list: listProcedure,
  get: getProcedure,
  create: createProcedure,
  refreshFigures: refreshFiguresProcedure,
  reconcile: reconcileProcedure,
  update: updateProcedure,
  addAttachment: addAttachmentProcedure,
  removeAttachment: removeAttachmentProcedure,
  attachmentUrl: attachmentUrlProcedure,
  delete: deleteProcedure,
  audienceOptions: audienceOptionsProcedure,
  release: releaseProcedure,
  publish: publishProcedure,
  unpublish: unpublishProcedure,
  addRecipients: addRecipientsProcedure,
  removeRecipient: removeRecipientProcedure,
  resend: resendProcedure,
  replaceLink: replaceLinkProcedure,
  exportXlsx: exportXlsxProcedure,
});
