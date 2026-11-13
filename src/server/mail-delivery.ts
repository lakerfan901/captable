import "server-only";

import { TRPCError } from "@trpc/server";
import {
  type MailDeliveryState,
  type MailPurpose,
  mailDeliveryState,
} from "@/lib/mail-delivery";
import { isMailCatcherConfigured } from "@/server/mailer";

// Server side of src/lib/mail-delivery.ts: the deployment's mail state, read
// at call time (NODE_ENV and EMAIL_SERVER), and the refusal every
// email-driven action runs BEFORE it writes anything.

export function currentMailDelivery(purpose: MailPurpose): MailDeliveryState {
  return mailDeliveryState(
    { nodeEnv: process.env.NODE_ENV, mailCatcher: isMailCatcherConfigured() },
    purpose,
  );
}

/** BAD_REQUEST in production while EMAIL_SERVER is the bundled mail catcher. */
export function assertMailDeliverable(purpose: MailPurpose): void {
  const reason = currentMailDelivery(purpose).blockedReason;
  if (reason !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: reason });
  }
}
