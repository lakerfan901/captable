// Portal sessions, cookie and Origin check (04-investor-portal.md 5.2, P7,
// P8, S17, S24; package P1). Pure: no database, no `@/` imports; time is
// passed in.
//
// The session cookie holds a `newToken()` value; the database holds only its
// SHA-256 (`PortalSession.tokenHash`). `loadPortalSession` (P2) parses the
// cookie with `parseCookie`, hashes it, loads the row and calls
// `classifySession`.

import { isTokenShape } from "./token-core";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** P7: a session lasts 7 days at most (absolute end, `PortalSession.expiresAt`). */
export const SESSION_MAX_AGE_MS = 7 * 24 * HOUR_MS;
/** P7: a session ends after 24 hours without use. */
export const SESSION_IDLE_MS = 24 * HOUR_MS;
/** 5.2: `lastSeenAt` is written only when it is more than 5 minutes old. */
export const SESSION_TOUCH_AFTER_MS = 5 * MINUTE_MS;

export const SECURE_COOKIE_NAME = "__Host-portal_session";
export const PLAIN_COOKIE_NAME = "portal_session";

export type SessionState = "OK" | "EXPIRED" | "IDLE" | "REVOKED";

export interface SessionRow {
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

/** `expiresAt` for a session created at `now`. */
export function sessionExpiresAt(now: Date): Date {
  return new Date(now.getTime() + SESSION_MAX_AGE_MS);
}

/**
 * REVOKED > EXPIRED > IDLE > OK. Each test is written as "still valid only
 * if", so an Invalid Date (or a missing field) never yields OK.
 *
 * - REVOKED: `revokedAt` is anything but null (sign-out, password set).
 * - EXPIRED: `expiresAt > now` does not hold (the end instant is excluded).
 * - IDLE: `lastSeenAt > now - 24h` does not hold.
 */
export function classifySession(row: SessionRow, now: Date): SessionState {
  if (row.revokedAt !== null) return "REVOKED";
  const t = now.getTime();
  if (!(row.expiresAt.getTime() > t)) return "EXPIRED";
  if (!(row.lastSeenAt.getTime() > t - SESSION_IDLE_MS)) return "IDLE";
  return "OK";
}

/**
 * Whether to write `lastSeenAt = now` for a session that is OK: only when the
 * stored value is more than 5 minutes old (one write per 5 minutes of use).
 * An unreadable stored value is refreshed.
 */
export function shouldTouch(lastSeenAt: Date, now: Date): boolean {
  const age = now.getTime() - lastSeenAt.getTime();
  if (Number.isNaN(age)) return true;
  return age > SESSION_TOUCH_AFTER_MS;
}

function parseBaseUrl(baseUrl: string): URL | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * `__Host-portal_session` when the app is served over https, `portal_session`
 * otherwise (a `__Host-` cookie must be `Secure`, which a browser refuses on
 * plain http). Throws on a base URL that is not http(s): that is a
 * configuration error and must not silently pick the weaker cookie.
 */
export function cookieName(baseUrl: string): string {
  const url = parseBaseUrl(baseUrl);
  if (!url) throw new RangeError("Base URL must be an http(s) URL");
  return url.protocol === "https:" ? SECURE_COOKIE_NAME : PLAIN_COOKIE_NAME;
}

/**
 * The attributes of 5.2 for setting the cookie: HttpOnly, Secure on https,
 * SameSite=Lax (an investor following an email link must arrive signed in),
 * Path=/, no Domain, Max-Age 7 days (seconds).
 */
export function cookieOptions(baseUrl: string): {
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  const name = cookieName(baseUrl);
  return {
    name,
    httpOnly: true,
    secure: name === SECURE_COOKIE_NAME,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000,
  };
}

/**
 * The portal session value from a `Cookie` request header, or null.
 *
 * - The name must match exactly (case-sensitive, no prefix or suffix match).
 * - The value is returned raw (no URL decoding) and only when it has the
 *   shape of a portal token; anything else is null.
 * - When the header carries the name more than once with different values
 *   (cookie tossing from a sibling host or a path-scoped cookie), the result
 *   is null: the server never guesses which session the browser meant.
 */
export function parseCookie(
  header: string | null | undefined,
  name: string,
): string | null {
  if (typeof header !== "string" || header.length === 0 || name.length === 0) {
    return null;
  }
  let found: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (found !== null && found !== value) return null;
    found = value;
  }
  return found !== null && isTokenShape(found) ? found : null;
}

/**
 * S17: the request's `Origin` header names exactly the app's origin. False
 * for a missing or empty header, the literal `"null"` (sandboxed frames,
 * some redirects), a list, a value with a path, query, fragment or user
 * information, a different scheme, host or port, and a base URL that cannot
 * be parsed. Never throws.
 */
export function sameOrigin(
  originHeader: string | null | undefined,
  baseUrl: string,
): boolean {
  if (typeof originHeader !== "string") return false;
  if (originHeader.length === 0 || originHeader === "null") return false;
  if (originHeader !== originHeader.trim()) return false;
  const base = parseBaseUrl(baseUrl);
  if (!base) return false;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.username !== "" || origin.password !== "") return false;
  // An Origin header is scheme://host[:port] and nothing else.
  if (`${origin.origin}/` !== origin.href) return false;
  if (originHeader.endsWith("/")) return false;
  return origin.origin === base.origin;
}
