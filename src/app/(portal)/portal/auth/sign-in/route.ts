import type { NextRequest } from "next/server";
import { safeNextPath } from "@/lib/portal/next-path";
import { db } from "@/server/db";
import { SIGN_IN_REFUSED_MESSAGE, verifySignIn } from "@/server/portal/account";
import {
  foreignOriginResponse,
  hasAppOrigin,
  jsonResponse,
  readJsonFields,
  requestFacts,
  SIGN_IN_MIN_RESPONSE_MS,
  setSessionCookie,
  waitUntil,
} from "@/server/portal/http";

// POST /portal/auth/sign-in (04-investor-portal.md 5.2 "Sign in"; P4, P6,
// S8, S10, S16, S17; package P2b). Rate-limited per IP by the proxy in the
// `portal-login` bucket (not next-auth's `login` bucket).
//
// Body (JSON): `{ email, password, next? }`.
// 200 `{ ok: true, next }` with the session cookie, `next` through
//     `safeNextPath` (anything unsafe becomes `/portal`).
// 401 `{ ok: false, error }` for EVERY refusal: unknown address, no password
//     yet, locked, wrong password, no ACTIVE access, and a malformed or
//     missing body. Same status, same body, and no answer before
//     `SIGN_IN_MIN_RESPONSE_MS` (S10).
// 403 for a request without the app's Origin (checked before anything else).

export async function POST(request: NextRequest) {
  if (!hasAppOrigin(request)) return foreignOriginResponse();
  const floor = Date.now() + SIGN_IN_MIN_RESPONSE_MS;
  const fields = await readJsonFields(request);
  const facts = requestFacts(request);
  try {
    // A malformed body still runs the full sign-in (one bcrypt comparison
    // against the dummy hash), so it answers like any other refusal.
    const result = await verifySignIn(db, {
      email: fields?.email,
      password: fields?.password,
      ...facts,
    });
    await waitUntil(floor);
    if (!result.ok) {
      return jsonResponse(401, { ok: false, error: SIGN_IN_REFUSED_MESSAGE });
    }
    const next = safeNextPath(fields?.next);
    const response = jsonResponse(200, { ok: true, next });
    setSessionCookie(response, result.sessionToken, result.sessionExpiresAt);
    return response;
  } catch (error) {
    await waitUntil(floor);
    throw error;
  }
}
