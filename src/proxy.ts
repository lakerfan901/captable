import { type NextRequest, NextResponse, userAgent } from "next/server";
import { logger } from "@/lib/logger";
import { env } from "./env";

const log = logger.child({ module: "proxy" });
// This function can be marked `async` if using `await` inside
export function proxy(request: NextRequest) {
  if (env.LOGS || env.NODE_ENV === "production" || env.NODE_ENV === "staging") {
    const { url, method } = request;
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
