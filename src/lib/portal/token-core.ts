// Portal account tokens (04-investor-portal.md 5.2, package P1). Pure: no
// database, no `@/` imports; randomness is injected.
//
// A token is 32 random bytes in base64url (43 characters, no padding). Only
// its SHA-256 (hex) is stored (`PortalAccountToken.tokenHash`,
// `PortalSession.tokenHash`), so a stolen database replays nothing (S12).
// It is NOT a JWT: it can never be confused with a ballot, report, update or
// data-room token and does not depend on `NEXTAUTH_SECRET`.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_BYTES = 32;
/** base64url length of `TOKEN_BYTES` bytes without padding: ceil(32 * 4 / 3). */
export const TOKEN_LENGTH = 43;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** P5: an invitation (set-password) link is valid for 7 days. */
export const SET_PASSWORD_TTL_MS = 7 * DAY_MS;
/** P5: a reset link is valid for 60 minutes. */
export const RESET_PASSWORD_TTL_MS = 60 * MINUTE_MS;

/** Mirrors `PortalTokenPurposeEnum` (section 4); defined here so P1 compiles without P0. */
export type PortalTokenPurpose = "SET_PASSWORD" | "RESET_PASSWORD";

export const TOKEN_TTL_MS: Readonly<Record<PortalTokenPurpose, number>> = {
  SET_PASSWORD: SET_PASSWORD_TTL_MS,
  RESET_PASSWORD: RESET_PASSWORD_TTL_MS,
};

// 43 base64url characters. The last character carries only 4 data bits (the
// remaining 2 are zero padding bits), so it is one of 16 characters. Being
// strict means a shape check accepts exactly the strings `newToken` can make.
const TOKEN_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** SHA-256 hex digest: what the database stores and is looked up by. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * A new random token and its hash. `random` is injectable for tests; it must
 * return exactly `TOKEN_BYTES` bytes (anything else throws, so a broken
 * source can never produce a short, guessable token).
 */
export function newToken(random: (size: number) => Uint8Array = randomBytes): {
  token: string;
  hash: string;
} {
  const bytes = random(TOKEN_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== TOKEN_BYTES) {
    throw new RangeError("Token source must return 32 bytes");
  }
  const token = Buffer.from(bytes).toString("base64url");
  return { token, hash: hashToken(token) };
}

/**
 * SHA-256 hex of the token STRING as sent by the browser (UTF-8), not of the
 * decoded bytes, so the stored hash matches whatever the client presents.
 * Callers check `isTokenShape` first; hashing a malformed value is harmless
 * (it simply finds no row).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True only for a string `newToken` could have produced. */
export function isTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** True only for a lower-case 64-character hex digest. */
export function isTokenHashShape(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

/**
 * Constant-time comparison of two stored-format hashes. Lookups go by the
 * hash in a unique index, so this is only for code that holds both values
 * (for example a re-check after a claim). Lengths are checked first because
 * `timingSafeEqual` throws on different lengths; a malformed value is false.
 */
export function tokenHashesEqual(a: unknown, b: unknown): boolean {
  if (!isTokenHashShape(a) || !isTokenHashShape(b)) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** When a token of this purpose issued at `now` stops working. */
export function tokenExpiresAt(purpose: PortalTokenPurpose, now: Date): Date {
  const ttl = TOKEN_TTL_MS[purpose];
  if (ttl === undefined) throw new RangeError("Unknown token purpose");
  return new Date(now.getTime() + ttl);
}

/**
 * The read-only check of the set-password page (`peekToken`): unused and not
 * yet expired. Written as "valid only if", so an Invalid Date fails closed.
 * The claim itself is the guarded UPDATE of 5.2; this only decides what the
 * page shows.
 */
export function tokenUsable(
  row: { expiresAt: Date; usedAt: Date | null },
  now: Date,
): boolean {
  if (row.usedAt !== null) return false;
  return row.expiresAt.getTime() > now.getTime();
}
