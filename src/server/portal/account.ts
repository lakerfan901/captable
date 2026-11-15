import "server-only";

import bcrypt from "bcryptjs";
import { env } from "@/env";
import { safeNextPath } from "@/lib/portal/next-path";
import {
  BCRYPT_COST,
  checkPassword,
  lockNoticeDue,
  PASSWORD_MAX_BYTES,
  type PasswordProblem,
  type SignInOutcome,
  signInOutcome,
  utf8ByteLength,
} from "@/lib/portal/password-core";
import { resetRequestAllowed } from "@/lib/portal/throttle-core";
import {
  hashToken,
  isTokenShape,
  newToken,
  type PortalTokenPurpose,
  tokenExpiresAt,
  tokenUsable,
} from "@/lib/portal/token-core";
import { normalizePortalEmail } from "@/lib/portal/visibility-core";
import type { TPrisma, TPrismaOrTransaction } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import {
  emitPortalAccountEmail,
  type PortalAccountEmailData,
} from "./account-email";
import { writePortalLog } from "./log";
import { createPortalSession, revokeSessions } from "./session";

// Portal accounts: tokens, password set and reset, sign-in, lockout, change
// password (04-investor-portal.md 5.2, rules P4–P6, P9, S8–S14; package P2a).
//
// CONCURRENCY. Every transaction that reads or writes a portal user's
// credentials, lockout counter, sessions or tokens first takes that user's
// row lock (`lockPortalUser`: SELECT … FOR UPDATE) and re-reads the row
// under it. That one lock is what makes the lockout counter, the reset
// throttle, the lock notice and the multi-row writes (revoke sessions, mark
// tokens used) race-free. A token claim is additionally a guarded
// single-row `update` (Prisma puts the filter on the UPDATE itself; the
// loser gets P2025, see src/server/guarded-write.ts), taken AFTER the user
// lock, never before (lock order: user row, then token row).
//
// bcrypt runs outside every transaction (it takes ~250 ms at cost 12). Code
// that compared against a hash re-checks under the lock that the stored hash
// is still that one, so a sign-in with the old password cannot create a
// session after a concurrent reset.
//
// NEUTRALITY. Sign-in has one refusal (`{ ok: false }`, no reason) for an
// unknown address, an account without a password, a locked account, a wrong
// password and an account without ACTIVE access, and always runs exactly one
// bcrypt comparison (against `DUMMY_HASH` when there is no hash to use).
// A reset request always returns nothing; the email goes out from a job.
//
// SECRETS. Tokens and session values are generated here and returned only
// to the caller that needs them (the route handler sets the cookie; the
// email job builds the link). Only their SHA-256 is stored. No token,
// password or hash is ever logged or put in an error.

/** The one sign-in refusal (5.2 step 3). */
export const SIGN_IN_REFUSED_MESSAGE =
  "Email or password is incorrect, or the account is temporarily locked.";

/** The one answer to a reset request (5.2 "Forgot password"). */
export const RESET_REQUESTED_MESSAGE =
  "If this address has portal access, a reset link is on its way.";

/** The answer of the set-password page for an unknown, used or expired link. */
export const TOKEN_EXPIRED_MESSAGE =
  "This link has expired or was already used.";

/**
 * A valid cost-12 bcrypt hash of a random value nobody knows. Compared
 * against when there is no real hash, so a sign-in for an unknown address
 * costs the same as one for a known address (S10). Must stay cost 12: a
 * cheaper dummy would make unknown addresses answer faster.
 */
const DUMMY_HASH =
  "$2b$12$c91ZHVYDTOuxZFVVW65RVu6mds2Sh6eQwhqYhcmb4F7NKus2uHnbu";

const MAX_IP = 64;

/** The context a session or log row records. */
export interface RequestFacts {
  ip: string;
  userAgent: string;
}

// ---------------------------------------------------------------------------
// Locks and small reads

const lockedUserSelect = {
  id: true,
  email: true,
  passwordHash: true,
  failedSignIns: true,
  lockedUntil: true,
  lockNoticeSentAt: true,
} as const;

/**
 * Takes the portal user's row lock for the rest of the transaction and
 * returns the row as committed now (READ COMMITTED: the statement after the
 * lock sees every write committed before the lock was granted). Null when
 * the user does not exist. Re-entrant within one transaction.
 */
export async function lockPortalUser(
  tx: TPrismaOrTransaction,
  portalUserId: string,
) {
  await tx.$queryRaw`SELECT id FROM "PortalUser" WHERE id = ${portalUserId} FOR UPDATE`;
  return tx.portalUser.findUnique({
    where: { id: portalUserId },
    select: lockedUserSelect,
  });
}

/** P9: a portal user with no ACTIVE access signs in to nothing and gets no reset email. */
export async function hasActiveAccess(
  db: TPrismaOrTransaction,
  portalUserId: string,
): Promise<boolean> {
  const access = await db.portalAccess.findFirst({
    where: { portalUserId, status: "ACTIVE" },
    select: { id: true },
  });
  return access !== null;
}

/**
 * bcrypt.compare that never shortcuts: a non-string or an over-long password
 * is compared as the empty string against the dummy hash (same cost) and
 * reported as not matching. Over 72 bytes is refused rather than compared,
 * because bcrypt would read only the first 72 bytes (S13).
 */
async function comparePassword(
  password: unknown,
  hash: string | null,
): Promise<boolean> {
  const usable =
    typeof password === "string" &&
    utf8ByteLength(password) <= PASSWORD_MAX_BYTES;
  const matched = await bcrypt.compare(
    usable ? password : "",
    hash ?? DUMMY_HASH,
  );
  return usable && hash !== null && matched;
}

/** Marks every unused token of the user used (a password was set; S11). Under the user lock only. */
async function retireTokens(
  tx: TPrismaOrTransaction,
  portalUserId: string,
  now: Date,
  purpose?: PortalTokenPurpose,
): Promise<void> {
  await tx.portalAccountToken.updateMany({
    where: {
      portalUserId,
      usedAt: null,
      ...(purpose === undefined ? {} : { purpose }),
    },
    data: { usedAt: now },
  });
}

/**
 * Stores a refused attempt's new lock state (under the user lock). On the
 * attempt that locks the account, writes ACCOUNT_LOCKED and claims the lock
 * notice when one is due (at most one a day); returns the email to queue
 * after commit, or null.
 */
async function applyRefusal(
  tx: TPrismaOrTransaction,
  user: {
    id: string;
    failedSignIns: number;
    lockedUntil: Date | null;
    lockNoticeSentAt: Date | null;
  },
  outcome: SignInOutcome,
  facts: RequestFacts,
  now: Date,
): Promise<PortalAccountEmailData | null> {
  const changed =
    outcome.failedSignIns !== user.failedSignIns ||
    (outcome.lockedUntil?.getTime() ?? null) !==
      (user.lockedUntil?.getTime() ?? null);
  if (!changed) return null;
  const noticeDue =
    outcome.lockedNow && lockNoticeDue(user.lockNoticeSentAt, now);
  await tx.portalUser.update({
    where: { id: user.id },
    data: {
      failedSignIns: outcome.failedSignIns,
      lockedUntil: outcome.lockedUntil,
      ...(noticeDue ? { lockNoticeSentAt: now } : {}),
    },
    select: { id: true },
  });
  if (!outcome.lockedNow) return null;
  const event = await writePortalLog(
    tx,
    {
      portalUser: { id: user.id },
      requestIp: facts.ip,
      userAgent: facts.userAgent,
    },
    { event: "ACCOUNT_LOCKED" },
  );
  return noticeDue ? { kind: "LOCKED", eventId: event.id } : null;
}

// ---------------------------------------------------------------------------
// Tokens

/**
 * Issues a SET_PASSWORD (7 days) or RESET_PASSWORD (60 minutes) token row
 * and marks the user's older unused tokens of the same purpose used. Returns
 * only the row id: the secret is put on the row by `mintTokenForDelivery`
 * when the email is sent, so no usable secret exists before then and none is
 * ever stored or queued. Until minted, the row carries the hash of a
 * discarded random value, which nobody can present.
 *
 * Takes the user's row lock itself (re-entrant), so callers in P3 and P4 do
 * not have to. Queue the email (`emitPortalAccountEmail({ kind: "INVITE" |
 * "RESET", tokenId })`) after the transaction commits.
 */
export async function issueToken(
  tx: TPrismaOrTransaction,
  input: {
    portalUserId: string;
    purpose: PortalTokenPurpose;
    nextPath?: string | null;
    requestIp: string | null;
    now?: Date;
  },
): Promise<{ tokenId: string }> {
  const now = input.now ?? new Date();
  const user = await lockPortalUser(tx, input.portalUserId);
  if (user === null) throw new Error("Portal user not found");
  await retireTokens(tx, user.id, now, input.purpose);
  const nextPath =
    input.nextPath === undefined || input.nextPath === null
      ? null
      : safeNextPath(input.nextPath);
  const row = await tx.portalAccountToken.create({
    data: {
      portalUserId: user.id,
      tokenHash: newToken().hash,
      purpose: input.purpose,
      nextPath,
      expiresAt: tokenExpiresAt(input.purpose, now),
      requestIp:
        input.requestIp === null ? null : input.requestIp.slice(0, MAX_IP),
      createdAt: now,
    },
    select: { id: true },
  });
  return { tokenId: row.id };
}

/** The address of the set-password page for a raw token. */
export function setPasswordUrl(token: string): string {
  return `${env.NEXT_PUBLIC_BASE_URL}/portal/set-password/${token}`;
}

/**
 * For the account-email job (P2b): gives a still-usable token row a fresh
 * secret and returns it, once, with what the email needs. A guarded
 * single-row update (`usedAt` null, not expired); null when the token was
 * used, retired or has expired, and then nothing may be sent. Each call
 * replaces the secret, so only the link of the latest email works.
 * The returned `token` and `url` must go into the email body only: never
 * into a log line, the email subject, an error or the job's result.
 */
export async function mintTokenForDelivery(
  db: TPrismaOrTransaction,
  tokenId: string,
  now: Date = new Date(),
): Promise<{
  token: string;
  url: string;
  purpose: PortalTokenPurpose;
  email: string;
  portalUserId: string;
  expiresAt: Date;
} | null> {
  const { token, hash } = newToken();
  const row = await guardedUpdate(() =>
    db.portalAccountToken.update({
      where: { id: tokenId, usedAt: null, expiresAt: { gt: now } },
      data: { tokenHash: hash },
      select: {
        purpose: true,
        expiresAt: true,
        portalUser: { select: { id: true, email: true } },
      },
    }),
  );
  if (row === null || row.portalUser === null) return null;
  return {
    token,
    url: setPasswordUrl(token),
    purpose: row.purpose,
    email: row.portalUser.email,
    portalUserId: row.portalUser.id,
    expiresAt: row.expiresAt,
  };
}

/**
 * Read-only look-up for the set-password page: the address the link is for,
 * or null for a malformed, unknown, used or expired token, and for a user
 * without ACTIVE access (P9). Consumes nothing.
 */
export async function peekToken(
  db: TPrismaOrTransaction,
  token: unknown,
  now: Date = new Date(),
): Promise<{ email: string; purpose: PortalTokenPurpose } | null> {
  if (!isTokenShape(token)) return null;
  const row = await db.portalAccountToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      purpose: true,
      expiresAt: true,
      usedAt: true,
      portalUser: { select: { id: true, email: true } },
    },
  });
  if (row === null || row.portalUser === null) return null;
  if (!tokenUsable(row, now)) return null;
  if (!(await hasActiveAccess(db, row.portalUser.id))) return null;
  return { email: row.portalUser.email, purpose: row.purpose };
}

// ---------------------------------------------------------------------------
// Set a password with an emailed link

export type SetPasswordResult =
  | {
      ok: true;
      portalUserId: string;
      /** The new session's cookie value: for `Set-Cookie` only. */
      sessionToken: string;
      sessionExpiresAt: Date;
      /** `safeNextPath` of the token's `nextPath`, else `/portal`. */
      next: string;
    }
  | { ok: false; reason: "EXPIRED" }
  | { ok: false; reason: "WEAK"; problem: PasswordProblem };

/**
 * 5.2 "Set or reset a password", steps 2–4 (the route handler does the
 * Origin check and the cookie). A weak password is refused before anything
 * is written, so the link still works. The hash is computed before the
 * transaction; in the transaction, under the user lock: claim the token
 * (guarded single-row update; a used, expired, replaced or concurrently
 * claimed token answers EXPIRED and nothing is written), store the hash,
 * clear the lockout, retire every other outstanding token, revoke every
 * session, create the new session, log PASSWORD_SET and SIGNED_IN. Any
 * failure rolls the claim back. After commit, the "password changed" email
 * is queued (no link).
 */
export async function setPasswordWithToken(
  db: TPrisma,
  input: { token: unknown; password: unknown } & RequestFacts & { now?: Date },
): Promise<SetPasswordResult> {
  const now = input.now ?? new Date();
  const expired = { ok: false, reason: "EXPIRED" } as const;
  if (!isTokenShape(input.token)) return expired;
  const tokenHash = hashToken(input.token);
  const found = await db.portalAccountToken.findUnique({
    where: { tokenHash },
    select: {
      expiresAt: true,
      usedAt: true,
      portalUser: { select: { id: true, email: true } },
    },
  });
  if (found === null || found.portalUser === null || !tokenUsable(found, now)) {
    return expired;
  }
  const user = found.portalUser;
  const policy = checkPassword(input.password, user.email);
  if (!policy.ok) return { ok: false, reason: "WEAK", problem: policy.reason };
  // checkPassword accepted exactly this string; it is hashed unchanged.
  const password = input.password as string;
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const result = await db.$transaction(
    async (tx) => {
      const locked = await lockPortalUser(tx, user.id);
      if (locked === null) return null;
      if (!(await hasActiveAccess(tx, user.id))) return null;
      const claim = await guardedUpdate(() =>
        tx.portalAccountToken.update({
          where: {
            tokenHash,
            portalUserId: user.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
          select: { id: true, nextPath: true },
        }),
      );
      if (claim === null) return null;
      await tx.portalUser.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordSetAt: now,
          failedSignIns: 0,
          lockedUntil: null,
          lastSignInAt: now,
        },
        select: { id: true },
      });
      await retireTokens(tx, user.id, now);
      await revokeSessions(tx, { portalUserId: user.id, now });
      const session = await createPortalSession(tx, {
        portalUserId: user.id,
        ip: input.ip,
        userAgent: input.userAgent,
        now,
      });
      const logCtx = {
        portalUser: { id: user.id },
        requestIp: input.ip,
        userAgent: input.userAgent,
      };
      const event = await writePortalLog(tx, logCtx, { event: "PASSWORD_SET" });
      await writePortalLog(tx, logCtx, { event: "SIGNED_IN" });
      return { session, nextPath: claim.nextPath, eventId: event.id };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
  if (result === null) return expired;
  await emitPortalAccountEmail({
    kind: "PASSWORD_CHANGED",
    eventId: result.eventId,
  });
  return {
    ok: true,
    portalUserId: user.id,
    sessionToken: result.session.token,
    sessionExpiresAt: result.session.expiresAt,
    next: safeNextPath(result.nextPath ?? undefined),
  };
}

// ---------------------------------------------------------------------------
// Sign in

export type SignInResult =
  | {
      ok: true;
      portalUserId: string;
      /** The new session's cookie value: for `Set-Cookie` only. */
      sessionToken: string;
      sessionExpiresAt: Date;
    }
  /** One refusal for every reason (S10); show `SIGN_IN_REFUSED_MESSAGE`. */
  | { ok: false };

/**
 * 5.2 "Sign in", steps 2–5 (the route handler does the Origin check, the
 * `next` path and the cookie). Exactly one bcrypt comparison on every path.
 * Under the user lock: re-read the counter and the lock, apply
 * `signInOutcome`, and on success (and only with an ACTIVE access, P9)
 * create the session and log SIGNED_IN. On the attempt that locks the
 * account: ACCOUNT_LOCKED and, at most once a day, the lock email.
 */
export async function verifySignIn(
  db: TPrisma,
  input: { email: unknown; password: unknown } & RequestFacts & { now?: Date },
): Promise<SignInResult> {
  const now = input.now ?? new Date();
  const refused = { ok: false } as const;
  const email = normalizePortalEmail(input.email);
  const user =
    email === null
      ? null
      : await db.portalUser.findUnique({
          where: { email },
          select: { id: true, passwordHash: true },
        });
  const comparedHash = user?.passwordHash ?? null;
  const matched = await comparePassword(input.password, comparedHash);
  if (user === null || comparedHash === null) return refused;

  const result = await db.$transaction(
    async (tx) => {
      const fresh = await lockPortalUser(tx, user.id);
      // The password changed between the comparison and the lock: this
      // attempt was checked against a hash that no longer applies. Refused,
      // and not counted (it was not a guess against the current password).
      if (fresh === null || fresh.passwordHash !== comparedHash) {
        return { ok: false as const, email: null };
      }
      const outcome = signInOutcome(fresh, matched, now);
      if (outcome.result === "REFUSED") {
        const notice = await applyRefusal(tx, fresh, outcome, input, now);
        return { ok: false as const, email: notice };
      }
      if (!(await hasActiveAccess(tx, user.id))) {
        return { ok: false as const, email: null };
      }
      await tx.portalUser.update({
        where: { id: user.id },
        data: { failedSignIns: 0, lockedUntil: null, lastSignInAt: now },
        select: { id: true },
      });
      const session = await createPortalSession(tx, {
        portalUserId: user.id,
        ip: input.ip,
        userAgent: input.userAgent,
        now,
      });
      await writePortalLog(
        tx,
        {
          portalUser: { id: user.id },
          requestIp: input.ip,
          userAgent: input.userAgent,
        },
        { event: "SIGNED_IN" },
      );
      return { ok: true as const, session };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
  if (!result.ok) {
    if (result.email !== null) await emitPortalAccountEmail(result.email);
    return refused;
  }
  return {
    ok: true,
    portalUserId: user.id,
    sessionToken: result.session.token,
    sessionExpiresAt: result.session.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Change password (signed in)

export type ChangePasswordResult =
  | { ok: true }
  /** Wrong current password or a locked account (one answer for both). */
  | { ok: false; reason: "REFUSED" }
  | { ok: false; reason: "WEAK"; problem: PasswordProblem };

/**
 * 5.2 "Change password". The new password is checked against the policy
 * first (it reveals nothing about the account). The current password is
 * verified like a sign-in: a wrong one counts toward the lock, and a locked
 * account is refused whatever is typed. On success, under the user lock:
 * store the new hash, clear the lockout, retire outstanding tokens, revoke
 * every OTHER session (this one stays signed in), log PASSWORD_SET; after
 * commit, queue the "password changed" email.
 */
export async function changePassword(
  db: TPrisma,
  input: {
    portalUserId: string;
    sessionId: string;
    currentPassword: unknown;
    newPassword: unknown;
  } & RequestFacts & { now?: Date },
): Promise<ChangePasswordResult> {
  const now = input.now ?? new Date();
  const refused = { ok: false, reason: "REFUSED" } as const;
  const user = await db.portalUser.findUnique({
    where: { id: input.portalUserId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (user === null) return refused;
  const policy = checkPassword(input.newPassword, user.email);
  if (!policy.ok) return { ok: false, reason: "WEAK", problem: policy.reason };
  const comparedHash = user.passwordHash;
  const matched = await comparePassword(input.currentPassword, comparedHash);
  if (comparedHash === null) return refused;
  const newHash = matched
    ? await bcrypt.hash(input.newPassword as string, BCRYPT_COST)
    : null;

  const result = await db.$transaction(
    async (tx) => {
      const fresh = await lockPortalUser(tx, user.id);
      if (fresh === null || fresh.passwordHash !== comparedHash) {
        return { ok: false as const, email: null };
      }
      const outcome = signInOutcome(fresh, matched, now);
      if (outcome.result === "REFUSED" || newHash === null) {
        const notice = await applyRefusal(tx, fresh, outcome, input, now);
        return { ok: false as const, email: notice };
      }
      await tx.portalUser.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          passwordSetAt: now,
          failedSignIns: 0,
          lockedUntil: null,
        },
        select: { id: true },
      });
      await retireTokens(tx, user.id, now);
      await revokeSessions(tx, {
        portalUserId: user.id,
        now,
        exceptSessionId: input.sessionId,
      });
      const event = await writePortalLog(
        tx,
        {
          portalUser: { id: user.id },
          requestIp: input.ip,
          userAgent: input.userAgent,
        },
        { event: "PASSWORD_SET" },
      );
      return { ok: true as const, eventId: event.id };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
  if (!result.ok) {
    if (result.email !== null) await emitPortalAccountEmail(result.email);
    return refused;
  }
  await emitPortalAccountEmail({
    kind: "PASSWORD_CHANGED",
    eventId: result.eventId,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Forgot password

/**
 * 5.2 "Forgot password". Returns nothing, whatever the address: the caller
 * always answers `RESET_REQUESTED_MESSAGE`. A RESET_PASSWORD token (60
 * minutes) is issued, and its email queued after commit, only when the
 * address is a portal user with at least one ACTIVE access (P9) and the
 * per-address throttle allows it (3 tokens in 15 minutes, 10 in 24 hours,
 * counted over every token the user was sent, invitations included, under
 * the user lock so two concurrent requests cannot both pass). Works during
 * a lock; the lock is cleared when the password is set. A user who never
 * set a password gets the same link (it completes the invitation).
 */
export async function requestPasswordReset(
  db: TPrisma,
  input: { email: unknown; requestIp: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const email = normalizePortalEmail(input.email);
  if (email === null) return;
  const user = await db.portalUser.findUnique({
    where: { email },
    select: { id: true },
  });
  if (user === null) return;
  const issued = await db.$transaction(
    async (tx) => {
      const locked = await lockPortalUser(tx, user.id);
      if (locked === null) return null;
      if (!(await hasActiveAccess(tx, user.id))) return null;
      const recent = await tx.portalAccountToken.findMany({
        where: {
          portalUserId: user.id,
          createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) },
        },
        select: { createdAt: true },
      });
      if (
        !resetRequestAllowed(
          recent.map((r) => r.createdAt),
          now,
        )
      ) {
        return null;
      }
      return issueToken(tx, {
        portalUserId: user.id,
        purpose: "RESET_PASSWORD",
        requestIp: input.requestIp,
        now,
      });
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
  if (issued !== null) {
    await emitPortalAccountEmail({ kind: "RESET", tokenId: issued.tokenId });
  }
}
