import type { NextRequest } from "next/server";
import { safeNextPath } from "@/lib/portal/next-path";
import { PASSWORD_PROBLEM_MESSAGES } from "@/lib/portal/password-core";
import { db } from "@/server/db";
import {
  setPasswordWithToken,
  TOKEN_EXPIRED_MESSAGE,
} from "@/server/portal/account";
import {
  foreignOriginResponse,
  hasAppOrigin,
  jsonResponse,
  readJsonFields,
  requestFacts,
  setSessionCookie,
} from "@/server/portal/http";

// POST /portal/auth/set-password (04-investor-portal.md 5.2 "Set or reset a
// password"; P4, P5, S11, S13, S17; package P2b). Rate-limited per IP by
// the proxy in the `portal-login` bucket.
//
// Body (JSON): `{ token, password, confirm }`.
// 200 `{ ok: true, next }` with a new session cookie; `next` is the token's
//     stored path, through `safeNextPath` again, else `/portal`.
// 400 `{ ok: false, reason, error }` for a password the policy refuses or a
//     repeat that differs (`MISMATCH`). The link is not consumed.
// 410 `{ ok: false, reason: "EXPIRED", error }` for a malformed, unknown,
//     used, replaced or expired link, or a user without ACTIVE access.
// 403 for a request without the app's Origin (checked before anything else).
//
// The token proves control of the mailbox, so a good password signs the user
// in at once. `setPasswordWithToken` revokes every earlier session, clears a
// lockout, retires every other outstanding link and queues the "password
// changed" email.

export async function POST(request: NextRequest) {
  if (!hasAppOrigin(request)) return foreignOriginResponse();
  const fields = await readJsonFields(request);
  const password = fields?.password;
  if (typeof password !== "string") {
    return jsonResponse(400, {
      ok: false,
      reason: "NOT_A_STRING",
      error: PASSWORD_PROBLEM_MESSAGES.NOT_A_STRING,
    });
  }
  if (fields?.confirm !== password) {
    return jsonResponse(400, {
      ok: false,
      reason: "MISMATCH",
      error: "The two passwords do not match.",
    });
  }
  const result = await setPasswordWithToken(db, {
    token: fields?.token,
    password,
    ...requestFacts(request),
  });
  if (!result.ok) {
    if (result.reason === "EXPIRED") {
      return jsonResponse(410, {
        ok: false,
        reason: "EXPIRED",
        error: TOKEN_EXPIRED_MESSAGE,
      });
    }
    return jsonResponse(400, {
      ok: false,
      reason: result.problem,
      error: PASSWORD_PROBLEM_MESSAGES[result.problem],
    });
  }
  const response = jsonResponse(200, {
    ok: true,
    next: safeNextPath(result.next),
  });
  setSessionCookie(response, result.sessionToken, result.sessionExpiresAt);
  return response;
}
