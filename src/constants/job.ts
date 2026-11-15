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
  // Investor portal (04-investor-portal.md 5.6, 5.8). Handlers are added by
  // P2 (account-email) and P10 (notification-email).
  portal: ["account-email", "notification-email"],
} as const;
