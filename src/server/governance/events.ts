import "server-only";
import { db, type TPrismaOrTransaction } from "@/server/db";

// Resolution event log (03-governance.md G6, C3.6): INSERT ONLY, with one
// exception: `sendOnce` deletes its own claim row when the send it claimed
// failed (the email never left), so a retry can claim and send it.

export const RESOLUTION_EVENT_TYPES = [
  "SENT",
  "MANAGER_SIGNED",
  "COMMON_MEMBER_SIGNED",
  "BALLOT_ISSUED",
  "INVITE_EMAILED",
  "REMINDER_EMAILED",
  "LINK_REPLACED",
  "LINK_REVOKED",
  "BALLOT_VIEWED",
  "BALLOT_SUBMITTED",
  "BALLOT_DEEMED",
  "REQUIREMENT_SATISFIED",
  "EFFECTIVE",
  "FAILED",
  "EXPIRED",
  "WITHDRAWN",
  "PDF_FILED",
  "RESULT_EMAILED",
  "COPY_EMAILED",
  "COPY_DELIVERED",
  "MANAGER_NOTIFIED",
  "ADDRESS_CHANGE_NOTICE_EMAILED",
] as const;

export type ResolutionEventType = (typeof RESOLUTION_EVENT_TYPES)[number];
export type ResolutionEventActorType = "user" | "stakeholder" | "system";

export interface RecordEventInput {
  resolutionId: string;
  companyId: string;
  ballotId?: string | null;
  type: ResolutionEventType;
  actorType: ResolutionEventActorType;
  actorId?: string | null;
  summary: string;
  ip?: string | null;
  userAgent?: string | null;
}

function toRow(input: RecordEventInput, dedupeKey: string | null) {
  return {
    resolutionId: input.resolutionId,
    companyId: input.companyId,
    ballotId: input.ballotId ?? null,
    type: input.type,
    dedupeKey,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    summary: input.summary,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
}

export async function recordEvent(
  tx: TPrismaOrTransaction,
  input: RecordEventInput,
): Promise<void> {
  await tx.resolutionEvent.create({ data: toRow(input, null) });
}

/**
 * Inserts the event unless one with the same `(resolutionId, dedupeKey)`
 * exists. Returns true when this call inserted it.
 *
 * Uses INSERT … ON CONFLICT DO NOTHING (`skipDuplicates`) rather than
 * catching a unique violation: in Postgres a failed statement aborts the
 * surrounding transaction, so a caught P2002 would break every later
 * statement of the caller's transaction. The P2002 catch remains only as a
 * fallback for a call made outside a transaction.
 */
export async function recordEventOnce(
  tx: TPrismaOrTransaction,
  input: RecordEventInput & { dedupeKey: string },
): Promise<boolean> {
  if (input.dedupeKey.length === 0) {
    throw new Error("recordEventOnce needs a non-empty dedupeKey");
  }
  try {
    const { count } = await tx.resolutionEvent.createMany({
      data: [toRow(input, input.dedupeKey)],
      skipDuplicates: true,
    });
    return count === 1;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "P2002") {
      return false;
    }
    throw error;
  }
}

/**
 * At-most-once email delivery per dedupe key (03-governance.md G9, M1).
 *
 * 1. CLAIM: insert the event with its unique `(resolutionId, dedupeKey)` in
 *    its own committed statement (never inside the caller's transaction, so
 *    a concurrent delivery of the same job sees it at once). Only the caller
 *    whose insert succeeded goes on; every other delivery returns "SKIPPED".
 * 2. SEND.
 * 3. If the send throws, the claim is deleted (the email did not leave) and
 *    the error is rethrown, so pg-boss retries and the retry can claim again.
 *
 * A crash between 1 and 2 leaves a claim with no email: at most once, never
 * twice. `resolution.remind` (invites) and `resolution.resendNotice` (result
 * notices, PO copies) are the recovery paths; both use a fresh key.
 */
export async function sendOnce(
  claim: RecordEventInput & { dedupeKey: string },
  send: () => Promise<void>,
): Promise<"SENT" | "SKIPPED"> {
  const claimed = await recordEventOnce(db, claim);
  if (!claimed) return "SKIPPED";
  try {
    await send();
  } catch (error) {
    await db.resolutionEvent.deleteMany({
      where: { resolutionId: claim.resolutionId, dedupeKey: claim.dedupeKey },
    });
    throw error;
  }
  return "SENT";
}

export async function hasEvent(
  tx: TPrismaOrTransaction,
  resolutionId: string,
  dedupeKey: string,
): Promise<boolean> {
  const row = await tx.resolutionEvent.findFirst({
    where: { resolutionId, dedupeKey },
    select: { id: true },
  });
  return row !== null;
}
