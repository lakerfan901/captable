import "server-only";

import { env } from "@/env";
import {
  classifySession,
  cookieName,
  parseCookie,
  sessionExpiresAt,
  shouldTouch,
} from "@/lib/portal/session-core";
import { hashToken, newToken } from "@/lib/portal/token-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";

// Portal sessions (04-investor-portal.md 5.1, 5.2 "Session check", P7, P8,
// S12, S14, S24; package P2a).
//
// The portal has its own cookie and its own `PortalSession` rows. Nothing
// here reads or creates a next-auth session, and nothing in the team code
// reads this cookie: a portal session is never a team credential (G6) and a
// team session is never a portal credential (G1).
//
// The cookie carries a `newToken()` value; the database stores only its
// SHA-256, so a stolen table replays nothing.

/** The cookie name for this deployment (`__Host-portal_session` on https). */
export function portalCookieName(): string {
  return cookieName(env.NEXT_PUBLIC_BASE_URL);
}

export interface PortalSessionUser {
  sessionId: string;
  portalUser: { id: string; email: string; name: string | null };
}

const MAX_IP = 64;
const MAX_USER_AGENT = 512;

/**
 * The signed-in portal user for a `Cookie` request header, or null.
 *
 * Valid only when the cookie has the portal token shape, a row with its hash
 * exists, `revokedAt` is null, `expiresAt > now` and `lastSeenAt` is less
 * than 24 hours old (`classifySession`). `lastSeenAt` is written only when it
 * is more than 5 minutes old, by a guarded single-row update that never
 * touches a revoked row. Access rows are NOT checked here: a session of a
 * user whose every access is disabled stays valid and sees no holder
 * (`portal.me` lists none; `investorProcedure` refuses each access).
 */
export async function loadPortalSession(
  db: TPrismaOrTransaction,
  cookieHeader: string | null | undefined,
  now: Date = new Date(),
): Promise<PortalSessionUser | null> {
  const value = parseCookie(cookieHeader, portalCookieName());
  if (value === null) return null;
  const row = await db.portalSession.findUnique({
    where: { tokenHash: hashToken(value) },
    select: {
      id: true,
      expiresAt: true,
      lastSeenAt: true,
      revokedAt: true,
      portalUser: { select: { id: true, email: true, name: true } },
    },
  });
  if (row === null || row.portalUser === null) return null;
  if (classifySession(row, now) !== "OK") return null;
  if (shouldTouch(row.lastSeenAt, now)) {
    await guardedUpdate(() =>
      db.portalSession.update({
        where: { id: row.id, revokedAt: null },
        data: { lastSeenAt: now },
        select: { id: true },
      }),
    );
  }
  return {
    sessionId: row.id,
    portalUser: {
      id: row.portalUser.id,
      email: row.portalUser.email,
      name: row.portalUser.name,
    },
  };
}

/**
 * Creates a session and returns its cookie value. The value is returned to
 * the caller only (the route handler sets it as the cookie) and is never
 * stored, logged or put in an error. Call inside the transaction that holds
 * the portal user's row lock (`lockPortalUser`), so a concurrent password set
 * either sees this session and revokes it or makes this sign-in fail.
 */
export async function createPortalSession(
  tx: TPrismaOrTransaction,
  input: { portalUserId: string; ip: string; userAgent: string; now: Date },
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const { token, hash } = newToken();
  const expiresAt = sessionExpiresAt(input.now);
  const row = await tx.portalSession.create({
    data: {
      portalUserId: input.portalUserId,
      tokenHash: hash,
      expiresAt,
      lastSeenAt: input.now,
      ip: input.ip.slice(0, MAX_IP),
      userAgent: input.userAgent.slice(0, MAX_USER_AGENT),
      createdAt: input.now,
    },
    select: { id: true },
  });
  return { sessionId: row.id, token, expiresAt };
}

/**
 * Revokes every live session of a portal user, except `exceptSessionId` when
 * given (change password keeps the session that made the change). A
 * multi-row write: call it only while holding the user's row lock
 * (`lockPortalUser`), the lock every writer of sessions takes, so no session
 * can be created between the read and the write of this statement.
 */
export async function revokeSessions(
  tx: TPrismaOrTransaction,
  input: { portalUserId: string; now: Date; exceptSessionId?: string },
): Promise<number> {
  const result = await tx.portalSession.updateMany({
    where: {
      portalUserId: input.portalUserId,
      revokedAt: null,
      ...(input.exceptSessionId === undefined
        ? {}
        : { id: { not: input.exceptSessionId } }),
    },
    data: { revokedAt: input.now },
  });
  return result.count;
}

/** Sign-out: revokes one session (guarded single-row update). False when it was already revoked or does not exist. */
export async function revokeSession(
  db: TPrismaOrTransaction,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await guardedUpdate(() =>
    db.portalSession.update({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
      select: { id: true },
    }),
  );
  return row !== null;
}
