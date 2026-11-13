import { queueManager } from "../lib/queue";
import { authVerificationEmailWorker } from "./auth-verification-email";
import { eSignCompletePDFWorker } from "./esign-complete-pdf";
import { eSignConfirmationEmailWorker } from "./esign-confirmation-email";
import { eSignNotificationEmailWorker } from "./esign-email";
import { eSignPdfWorker } from "./esign-pdf";
import { ballotEmailWorker } from "./governance-ballot-email";
import { reportEmailWorker } from "./governance-report-email";
import { resolutionFinalizeWorker } from "./governance-resolution-finalize";
import { resolutionNoticeWorker } from "./governance-resolution-notice";
import { resolutionSweepWorker } from "./governance-resolution-sweep";
import { sendMemberInviteEmailWorker } from "./member-inivite-email";
import { passwordResetEmailWorker } from "./password-reset-email";
import { shareDataRoomEmailWorker } from "./share-data-room-email";
import { shareUpdateEmailWorker } from "./share-update-email";

export async function registerJobs() {
  queueManager.register(shareDataRoomEmailWorker);
  queueManager.register(shareUpdateEmailWorker);
  queueManager.register(passwordResetEmailWorker);
  queueManager.register(sendMemberInviteEmailWorker);
  queueManager.register(eSignNotificationEmailWorker);
  queueManager.register(authVerificationEmailWorker);
  queueManager.register(eSignConfirmationEmailWorker);
  queueManager.register(eSignPdfWorker);
  queueManager.register(eSignCompletePDFWorker);

  // governance workers and schedules are registered below by G8, G9, G12, G13, G14
  queueManager.register(ballotEmailWorker);
  queueManager.register(resolutionNoticeWorker);
  queueManager.register(resolutionFinalizeWorker);
  queueManager.register(resolutionSweepWorker);
  queueManager.register(reportEmailWorker);
  queueManager.schedule({
    name: "governance.resolution-sweep",
    cron: "*/15 * * * *",
  });
  //start
  await queueManager.start();
}
