export const JOB_TYPES = {
  email: [
    "auth-verify",
    "share-update",
    "share-data-room",
    "password-reset",
    "member-invite",
    "esign-confirmation",
    "esign-notification",
    "admission-notice",
  ],
  esign: ["generate-pdf", "complete-pdf"],
  governance: [
    "ballot-email",
    "resolution-notice",
    "resolution-finalize",
    "resolution-sweep",
    "report-email",
    "report-file",
    "daily-sweep",
  ],
} as const;
