import { type NextRequest, NextResponse, userAgent } from "next/server";
import { logger } from "@/lib/logger";
import { loggablePath } from "@/lib/token-redaction";
import { env } from "./env";

// The token rule lives in lib/token-redaction (shared with the Sentry hooks).
export { loggablePath };

const log = logger.child({ module: "proxy" });

// Emailed links (ballots, member reports, signing, updates) carry a signed
// token in the path or in the tRPC query string. A token is a credential, so
// the access log records the path with token-shaped segments redacted and
// never the query string.
// This function can be marked `async` if using `await` inside
export function proxy(request: NextRequest) {
  if (env.LOGS || env.NODE_ENV === "production" || env.NODE_ENV === "staging") {
    const { method } = request;
    const url = loggablePath(request.nextUrl.pathname);
    // `request.ip` and `request.geo` were removed in Next.js 15; read the
    // client address from the proxy header instead.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      undefined;
    const time = new Date().toISOString();
    const { device, browser, isBot } = userAgent(request);

    log.info({ method, time, url, ip, device, browser, isBot });
  }
  // Forward the requested path to server components (used by the dashboard
  // layout to send a cross-company deep link through /switch). Always
  // overwritten here, so a client-supplied value never reaches them.
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Matcher ignores _next/static, _next/image, or favicon.ico
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
