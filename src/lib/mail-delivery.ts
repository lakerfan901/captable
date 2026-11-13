// Whether an email-driven governance or economics action may run, given the
// deployment (P2, Codex review 2). Pure: relative imports only, no env read
// here (the caller injects `nodeEnv` and `mailCatcher`), so it is unit-tested.
//
// Rule (the same as Call Notices, `sendBlockedReason` in
// server/llc/economics/call-notices.logic.ts): in production, while the
// configured SMTP server is the bundled mail catcher (`isMailCatcherUrl`),
// nothing that is effective only when Members actually receive an email may
// happen: closing the books with a report, freezing a voting register and
// starting a response deadline, new or replaced links, reminders. Outside
// production the catcher is allowed for testing, and the review dialogs say
// so ("Test mode").

export type MailPurpose =
  | "REPORT"
  | "RESOLUTION"
  | "DISTRIBUTION_NOTICES"
  | "MEMBER_EMAIL";

const REAL_DELIVERY = "Email is not configured for real delivery.";
const CONFIGURE = "Set EMAIL_SERVER and EMAIL_FROM first.";

export const MAIL_BLOCKED_MESSAGE: Record<MailPurpose, string> = {
  REPORT: `${REAL_DELIVERY} Sending a report closes the books and is effective only when the Members actually receive it; it cannot be sent while emails only reach the local mail catcher. ${CONFIGURE}`,
  RESOLUTION: `${REAL_DELIVERY} Sending a resolution freezes the voting register and starts the response deadline, and is effective only when the Members actually receive it; it cannot be sent while emails only reach the local mail catcher. ${CONFIGURE}`,
  DISTRIBUTION_NOTICES: `${REAL_DELIVERY} Set EMAIL_SERVER and EMAIL_FROM before sending distribution notices.`,
  MEMBER_EMAIL: `${REAL_DELIVERY} Emails to Members would only reach the local mail catcher. ${CONFIGURE}`,
};

export const TEST_MODE_TEXT =
  "Test mode: emails go to the local mail catcher and are not delivered.";

export interface MailDeliveryEnv {
  /** `process.env.NODE_ENV` */
  nodeEnv: string | undefined;
  /** `isMailCatcherConfigured()` (server/mailer.ts) */
  mailCatcher: boolean;
}

export interface MailDeliveryState {
  /** Emails go to the mail catcher (show the "Test mode" banner). */
  testMode: boolean;
  /** Non-null: the action must be refused with this message. */
  blockedReason: string | null;
}

/** The refusal message, or null when the action may run. */
export function mailBlockedReason(
  env: MailDeliveryEnv,
  purpose: MailPurpose,
): string | null {
  return env.nodeEnv === "production" && env.mailCatcher
    ? MAIL_BLOCKED_MESSAGE[purpose]
    : null;
}

export function mailDeliveryState(
  env: MailDeliveryEnv,
  purpose: MailPurpose,
): MailDeliveryState {
  return {
    testMode: env.mailCatcher,
    blockedReason: mailBlockedReason(env, purpose),
  };
}
