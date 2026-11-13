import "server-only";
import type { TPrismaOrTransaction } from "@/server/db";

// Resolution event log (03-governance.md G6, C3.6): INSERT ONLY.

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
