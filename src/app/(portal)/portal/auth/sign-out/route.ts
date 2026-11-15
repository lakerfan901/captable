import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import {
  clearSessionCookie,
  foreignOriginResponse,
  hasAppOrigin,
  requestFacts,
} from "@/server/portal/http";
import { writePortalLog } from "@/server/portal/log";
import { loadPortalSession, revokeSession } from "@/server/portal/session";

// POST /portal/auth/sign-out (04-investor-portal.md 5.2 "Sign out"; P7,
// S17, S24; package P2b).
//
// Posted by a plain `<form method="post">` in the portal header, so it works
// before (and without) any client script. Origin check first (403). Then the
// session named by the cookie, if it is still valid, is revoked (guarded
// single-row update) and SIGNED_OUT is logged once, by the request that
// revoked it. The cookie is cleared and the browser is sent to the sign-in
// page with a 303 and a relative Location, whatever the cookie held: the
// answer does not depend on whether a session existed.

export async function POST(request: NextRequest) {
  if (!hasAppOrigin(request)) return foreignOriginResponse();
  const now = new Date();
  // The raw header, so `parseCookie`'s rules (exact name, token shape, a
  // duplicated cookie with two values is no session) apply here as well.
  const found = await loadPortalSession(db, request.headers.get("cookie"), now);
  if (found !== null && (await revokeSession(db, found.sessionId, now))) {
    const facts = requestFacts(request);
    await writePortalLog(
      db,
      {
        portalUser: { id: found.portalUser.id },
        requestIp: facts.ip,
        userAgent: facts.userAgent,
      },
      { event: "SIGNED_OUT" },
    );
  }
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/portal/sign-in", "Cache-Control": "no-store" },
  });
  clearSessionCookie(response);
  return response;
}
