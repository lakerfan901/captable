import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";
import { defineJob, defineWorkerConfig } from "@/lib/queue";

// The `portal.account-email` job: its name, payload and the one function
// that queues it (04-investor-portal.md 5.2, 5.8; package P2a). The worker
// that renders and sends the emails through `sendMail`, and its line in
// `src/jobs/register.ts`, are package P2b (`src/jobs/portal-account-email.ts`
// imports `portalAccountEmailConfig` from here).
//
// The payload never carries a token, a link or a password: only row ids.
// - INVITE / RESET: `tokenId`. The worker calls `mintTokenForDelivery`
//   (account.ts), which puts a fresh secret on the still-usable token row and
//   returns it once, in memory, for the email. A used or expired token
//   yields nothing and the worker sends nothing. This keeps the database,
//   including the pg-boss job table, free of any usable secret (S12).
// - ACCESS_ADDED: `accessId` (an address that already has a password was
//   given access to one more holder; no token).
// - PASSWORD_CHANGED / LOCKED: `eventId`, the `PortalAccessLog` row of the
//   PASSWORD_SET / ACCOUNT_LOCKED event (one job per event).

export const PORTAL_ACCOUNT_EMAIL_KINDS = [
  "INVITE",
  "ACCESS_ADDED",
  "RESET",
  "PASSWORD_CHANGED",
  "LOCKED",
] as const;

export type PortalAccountEmailKind =
  (typeof PORTAL_ACCOUNT_EMAIL_KINDS)[number];

const id = z.string().min(1).max(64);

export const portalAccountEmailConfig = defineWorkerConfig({
  name: "portal.account-email",
  policy: "stately",
  schema: z
    .object({
      kind: z.enum(PORTAL_ACCOUNT_EMAIL_KINDS),
      tokenId: id.optional(),
      accessId: id.optional(),
      eventId: id.optional(),
    })
    .strict(),
});

export type PortalAccountEmailData = z.infer<
  typeof portalAccountEmailConfig.schema
>;

/** The queue handle. Integration scripts replace `emit` to capture jobs. */
export const portalAccountEmailJob = defineJob(portalAccountEmailConfig);

/** Which id each kind needs; anything else is a programming error. */
function refOf(data: PortalAccountEmailData): string {
  switch (data.kind) {
    case "INVITE":
    case "RESET":
      if (!data.tokenId) throw new Error(`${data.kind} needs tokenId`);
      return data.tokenId;
    case "ACCESS_ADDED":
      if (!data.accessId) throw new Error("ACCESS_ADDED needs accessId");
      return data.accessId;
    case "PASSWORD_CHANGED":
    case "LOCKED":
      if (!data.eventId) throw new Error(`${data.kind} needs eventId`);
      return data.eventId;
  }
}

/** One job per token, access or event (the queue's `stately` policy drops a duplicate while one waits). */
export function portalAccountEmailSingletonKey(
  data: PortalAccountEmailData,
): string {
  return `portal-account-${data.kind.toLowerCase()}-${refOf(data)}`;
}

const log = logger.child({ module: "portal-account-email" });

/**
 * Queues one account email. Call AFTER the transaction that wrote the token,
 * access or event row has committed. Never throws: a failed enqueue is logged
 * (kind and row id only) and swallowed, so the caller's answer never depends
 * on it. That keeps `requestReset` neutral (the same answer whether or not an
 * email was due) and never undoes a committed password change. The owner
 * recovers with "Forgot password" (or the team with "Resend invitation").
 * A payload without the id its kind needs is a programming error and throws
 * before anything is queued.
 */
export async function emitPortalAccountEmail(
  data: PortalAccountEmailData,
): Promise<void> {
  const singletonKey = portalAccountEmailSingletonKey(data);
  try {
    await portalAccountEmailJob.emit(data, { singletonKey });
  } catch (error) {
    log.error(
      {
        kind: data.kind,
        tokenId: data.tokenId,
        accessId: data.accessId,
        eventId: data.eventId,
        err: error instanceof Error ? error.message : String(error),
      },
      "[Portal] could not queue an account email",
    );
  }
}
