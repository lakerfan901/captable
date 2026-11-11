import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";
import { type NextRequest, userAgent } from "next/server";
import { env } from "./env";

const log = logger.child({ module: "middleware" });
// This function can be marked `async` if using `await` inside
export function middleware(request: NextRequest) {
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
  return NextResponse.next();
}

export const config = {
  // Matcher ignores _next/static, _next/image, or favicon.ico
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
