import "server-only";

import { NextResponse } from "next/server";
import { env } from "@/env";
import { getIp, getUserAgent } from "@/lib/headers";
import { cookieOptions, sameOrigin } from "@/lib/portal/session-core";
import type { RequestFacts } from "./account";

// Shared pieces of the three portal route handlers
// (`src/app/(portal)/portal/auth/{sign-in,set-password,sign-out}/route.ts`;
// 04-investor-portal.md 5.2, S17, S21; package P2b).
//
// - Every handler checks `Origin` first (`sameOrigin`): a missing header,
//   `null` and any other origin are refused with 403 before the body is read.
//   The portal pages are served with a referrer policy that keeps the real
//   origin in that header (`strict-origin-when-cross-origin`, and
//   `same-origin` on the set-password page; never `no-referrer`, under which
//   a browser may send `Origin: null`).
// - Bodies are JSON only (the pages post with `fetch`). A body is never
//   logged, never echoed and never put in an error.
// - Every answer carries `Cache-Control: no-store`.
// - The session cookie is set and cleared with the attributes of
//   `cookieOptions` (HttpOnly, SameSite=Lax, Path=/, Secure and the
//   `__Host-` name on https). Clearing repeats them, because a browser
//   ignores a `__Host-` cookie write without `Secure`.

/**
 * Every sign-in answer after the Origin check takes at least this long. An
 * unknown address costs one bcrypt comparison (~220 ms at cost 12 on a
 * developer machine); a known one adds a locked transaction and maybe an
 * enqueue. Padding both to one floor removes that difference (S10). Above
 * the measured work, below what a person notices on a sign-in.
 */
export const SIGN_IN_MIN_RESPONSE_MS = 600;

/** Larger bodies are refused unread (an email, a password and a path fit in far less). */
export const MAX_BODY_BYTES = 4096;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** S17: the request's Origin names exactly the app's origin. */
export function hasAppOrigin(request: Request): boolean {
  return sameOrigin(request.headers.get("origin"), env.NEXT_PUBLIC_BASE_URL);
}

/** The one answer to a request from another origin (or with none). */
export function foreignOriginResponse(): NextResponse {
  return jsonResponse(403, { ok: false, error: "Forbidden" });
}

/** IP and user agent as the tRPC context records them (`@/lib/headers`). */
export function requestFacts(request: Request): RequestFacts {
  return {
    ip: getIp(request.headers),
    userAgent: getUserAgent(request.headers),
  };
}

/**
 * The JSON object of the body, or null when the body is not JSON, is not an
 * object, or is larger than `MAX_BODY_BYTES`. Only string fields are kept;
 * any other value becomes absent, so the callers' checks see `undefined`.
 */
export async function readJsonFields(
  request: Request,
): Promise<Record<string, string> | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

/** Sets the portal session cookie on a response. */
export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
): void {
  const { name, ...options } = cookieOptions(env.NEXT_PUBLIC_BASE_URL);
  response.cookies.set(name, token, { ...options, expires: expiresAt });
}

/** Clears the portal session cookie (same attributes, empty value, Max-Age 0). */
export function clearSessionCookie(response: NextResponse): void {
  const { name, ...options } = cookieOptions(env.NEXT_PUBLIC_BASE_URL);
  response.cookies.set(name, "", { ...options, maxAge: 0 });
}

/** Waits until `floor` (an epoch millisecond time) has passed. */
export async function waitUntil(floor: number): Promise<void> {
  const wait = floor - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
