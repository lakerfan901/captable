import { type NextRequest, NextResponse, userAgent } from "next/server";
import { BASELINE_CSP, buildCsp, cspReportOnly } from "@/lib/csp";
import { logger } from "@/lib/logger";
import {
  checkRateLimit,
  clientIp,
  FixedWindowLimiter,
  type RateLimitBucket,
  TOO_MANY_REQUESTS_MESSAGE,
  trpcTooManyRequestsBody,
} from "@/lib/rate-limit";
import { loggablePath } from "@/lib/token-redaction";
import { env } from "./env";

// The token rule lives in lib/token-redaction (shared with the Sentry hooks).
export { loggablePath };

const log = logger.child({ module: "proxy" });

// In-memory rate limiter (src/lib/rate-limit.ts): one per process, kept on
// globalThis so a re-evaluated module (dev reloads) keeps its counters.
const globalForLimiter = globalThis as unknown as {
  captableRateLimiter?: FixedWindowLimiter;
};
globalForLimiter.captableRateLimiter ??= new FixedWindowLimiter();
const limiter = globalForLimiter.captableRateLimiter;

/** The 429 for a refused request, in the shape its caller can read. */
function tooManyRequests(
  request: NextRequest,
  bucket: RateLimitBucket,
  retryAfterSeconds: number,
): NextResponse {
  const headers = {
    "Retry-After": String(retryAfterSeconds),
    "Cache-Control": "no-store",
  };
  const { pathname, searchParams } = request.nextUrl;
  if (bucket === "login") {
    // next-auth's `signIn()` reads `{ url }` and follows it (or returns its
    // `error` parameter with `redirect: false`).
    return NextResponse.json(
      { url: `${env.NEXTAUTH_URL}/login?error=TooManyRequests` },
      { status: 429, headers },
    );
  }
  if (bucket === "account" || bucket === "token-api") {
    return NextResponse.json(
      trpcTooManyRequestsBody(pathname, searchParams.get("batch") === "1"),
      { status: 429, headers },
    );
  }
  return new NextResponse(TOO_MANY_REQUESTS_MESSAGE, {
    status: 429,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Emailed links (ballots, member reports, signing, updates) carry a signed
// token in the path or in the tRPC query string. A token is a credential, so
// the access log records the path with token-shaped segments redacted and
// never the query string.
export function proxy(request: NextRequest) {
  // The health check (src/app/api/health/route.ts) is polled every few
  // seconds: not logged, never limited, no session involved.
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  // `request.ip` and `request.geo` were removed in Next.js 15; the client
  // address comes from the reverse proxy's X-Forwarded-For (leftmost entry,
  // see src/lib/rate-limit.ts for the trust assumption), else X-Real-IP.
  const ip = clientIp(request.headers);
  const { method } = request;
  const url = loggablePath(request.nextUrl.pathname);
  if (env.LOGS || env.NODE_ENV === "production" || env.NODE_ENV === "staging") {
    const time = new Date().toISOString();
    const { device, browser, isBot } = userAgent(request);

    log.info({ method, time, url, ip, device, browser, isBot });
  }

  // Rate limit the unauthenticated entry points per client IP. No usable
  // address: not limited (fail open), never one shared bucket.
  const limited = checkRateLimit(
    limiter,
    { method, pathname: request.nextUrl.pathname, ip },
    Date.now(),
  );
  if (limited && !limited.allowed) {
    log.warn(
      {
        url,
        ip,
        bucket: limited.bucket,
        retryAfter: limited.retryAfterSeconds,
      },
      "Rate limit exceeded",
    );
    return tooManyRequests(request, limited.bucket, limited.retryAfterSeconds);
  }

  // Forward the requested path to server components (used by the dashboard
  // layout to send a cross-company deep link through /switch). Always
  // overwritten here, so a client-supplied value never reaches them.
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);

  // Content-Security-Policy with a fresh nonce. Next.js reads the nonce from
  // the REQUEST header and stamps it on the scripts it renders; the browser
  // gets the policy on the response.
  const { policy, reportOnly } = contentSecurityPolicy();
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  if (reportOnly) {
    response.headers.set("Content-Security-Policy", BASELINE_CSP);
    response.headers.set("Content-Security-Policy-Report-Only", policy);
  } else {
    response.headers.set("Content-Security-Policy", policy);
  }
  return response;
}

// Read at request time with a computed key so the build never inlines a
// value: one image serves every environment.
const runtimeEnv = (key: string): string | undefined =>
  process.env[key] || undefined;

function contentSecurityPolicy(): { policy: string; reportOnly: boolean } {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    baseUrl: runtimeEnv("NEXT_PUBLIC_BASE_URL"),
    uploadEndpoint: runtimeEnv("UPLOAD_ENDPOINT"),
    // NEXT_PUBLIC_* values may also be baked in at build time (the literal
    // `process.env.NEXT_PUBLIC_…` is inlined), which is what the browser
    // Sentry setup and the upload code fall back to: the policy follows the
    // same order, runtime value first.
    uploadDomain:
      runtimeEnv("NEXT_PUBLIC_UPLOAD_DOMAIN") ??
      process.env.NEXT_PUBLIC_UPLOAD_DOMAIN,
    forcePathStyle: ["true", "1"].includes(
      runtimeEnv("UPLOAD_FORCE_PATH_STYLE") ?? "",
    ),
    buckets: [
      runtimeEnv("UPLOAD_BUCKET_PUBLIC"),
      runtimeEnv("UPLOAD_BUCKET_PRIVATE"),
    ],
    sentryDsn:
      runtimeEnv("NEXT_PUBLIC_SENTRY_DSN") ??
      process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
  // CSP_MODE=report-only: the full policy only reports; the baseline
  // (framing, base, plugins, form targets) stays enforced.
  return { policy, reportOnly: cspReportOnly(runtimeEnv("CSP_MODE")) };
}

export const config = {
  // Matcher ignores _next/static, _next/image, or favicon.ico
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
