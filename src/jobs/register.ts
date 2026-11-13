import { queueManager } from "../lib/queue";
import { admissionNoticeEmailWorker } from "./admission-notice-email";
import { authVerificationEmailWorker } from "./auth-verification-email";
import { eSignCompletePDFWorker } from "./esign-complete-pdf";
import { eSignConfirmationEmailWorker } from "./esign-confirmation-email";
import { eSignNotificationEmailWorker } from "./esign-email";
import { eSignPdfWorker } from "./esign-pdf";
import { ballotEmailWorker } from "./governance-ballot-email";
import { dailySweepWorker } from "./governance-daily-sweep";
import { reportEmailWorker } from "./governance-report-email";
import { reportFileWorker } from "./governance-report-file";
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
  queueManager.register(admissionNoticeEmailWorker);

  // governance workers and schedules are registered below by G8, G9, G12, G13, G14
  queueManager.register(ballotEmailWorker);
  queueManager.register(resolutionNoticeWorker);
  queueManager.register(resolutionFinalizeWorker);
  queueManager.register(resolutionSweepWorker);
  queueManager.register(reportEmailWorker);
  queueManager.register(reportFileWorker);
  queueManager.schedule({
    name: "governance.resolution-sweep",
    cron: "*/15 * * * *",
  });
  queueManager.register(dailySweepWorker);
  queueManager.schedule({
    name: "governance.daily-sweep",
    cron: "0 7 * * *",
    tz: "America/Denver",
  });
  //start
  await queueManager.start();
}
