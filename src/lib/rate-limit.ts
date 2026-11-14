// Per-client-IP rate limiting for the unauthenticated entry points, enforced
// in the proxy (src/proxy.ts). Pure: no env, no Next imports, so it is
// unit-tested (rate-limit.test.ts) and the proxy only wires it in.
//
// IN-MEMORY: the counters live in the one app process (production runs a
// single app container). With several replicas each would count on its own,
// so the effective limit would be multiplied by the replica count; a shared
// store (Postgres / Redis) would be needed then.
//
// CLIENT IP: the leftmost `X-Forwarded-For` entry, else `X-Real-IP` (the same
// derivation the proxy's access log uses). This is only the real client when
// the reverse proxy in front (Traefik) OVERWRITES a client-supplied
// `X-Forwarded-For` rather than appending to it (Traefik's default for
// untrusted sources). When no usable address is present, or the address is
// loopback / private / link-local (a proxy hop, see `isNonRoutable`), the
// request is NOT limited (fail open): one shared bucket would let a single
// client lock everybody out. A CDN in front of Traefik would make the key the
// CDN edge address unless Traefik is told to trust the CDN's header.
//
// LIMITS are loose on purpose: a whole office can sit behind one address.

export type RateLimitBucket = "login" | "account" | "token-page" | "token-api";

export interface BucketRule {
  /** Requests allowed per window per client IP. */
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS: Record<RateLimitBucket, BucketRule> = {
  // Credential and passkey sign-in (POST /api/auth/callback/…).
  login: { limit: 30, windowMs: 60_000 },
  // Sign-up, password reset, email verification, passkey sign-in options.
  account: { limit: 30, windowMs: 60_000 },
  // Emailed-link pages (/esign/<token>, /w9/<token>, /ballots/<token>, …).
  "token-page": { limit: 120, windowMs: 60_000 },
  // The public tRPC procedures behind those pages.
  "token-api": { limit: 240, windowMs: 60_000 },
};

/** Unauthenticated tRPC procedures of the sign-up / password / sign-in flows. */
const ACCOUNT_PROCEDURES = new Set([
  "auth.signup",
  "auth.resendEmail",
  "auth.verifyEmail",
  "auth.forgotPassword",
  "auth.newPassword",
  "passkey.createSigninOptions",
]);

/** Unauthenticated tRPC procedures behind the emailed-link pages. */
const TOKEN_PROCEDURES = new Set([
  "ballot.view",
  "ballot.markViewed",
  "ballot.submit",
  "ballot.executedPdf",
  "memberReportView.view",
  "memberReportView.markViewed",
  "memberReportView.attachmentUrl",
  "template.sign",
  "template.getSigningFields",
  "admission.w9Info",
  "admission.w9UploadUrl",
  "admission.w9Complete",
]);

/** Public pages opened from an emailed link (credential in the path or query). */
const TOKEN_PAGE_PREFIXES = [
  "/esign/",
  "/w9/",
  "/ballots/",
  "/member-reports/",
  "/verify-member/",
  "/verify-email/",
  "/reset-password/",
  "/set-password/",
  "/data-rooms/",
  "/updates/",
];

const LOGIN_PATHS = new Set([
  "/api/auth/callback/credentials",
  "/api/auth/callback/webauthn",
]);

const TRPC_PREFIX = "/api/trpc/";

/** The procedure paths of a tRPC request (batched calls are comma-joined). */
export function trpcProcedures(pathname: string): string[] {
  if (!pathname.startsWith(TRPC_PREFIX)) return [];
  let rest = pathname.slice(TRPC_PREFIX.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Malformed escape: keep it raw (it then matches no procedure).
  }
  return rest.split(",").filter((p) => p.length > 0);
}

/** Which bucket a request counts against, or null when it is not limited. */
export function classifyRequest(
  method: string,
  pathname: string,
): RateLimitBucket | null {
  if (LOGIN_PATHS.has(pathname)) {
    return method === "POST" ? "login" : null;
  }
  const procedures = trpcProcedures(pathname);
  if (procedures.length > 0) {
    // One count per HTTP request, against the strictest bucket it touches.
    if (procedures.some((p) => ACCOUNT_PROCEDURES.has(p))) return "account";
    if (procedures.some((p) => TOKEN_PROCEDURES.has(p))) return "token-api";
    return null;
  }
  if (
    TOKEN_PAGE_PREFIXES.some(
      (prefix) =>
        pathname.startsWith(prefix) && pathname.length > prefix.length,
    )
  ) {
    return "token-page";
  }
  return null;
}

/** IPv4, IPv6 (optionally bracketed / zone-suffixed) or IPv4-mapped IPv6. */
const IP_SHAPE = /^[0-9A-Fa-f:.]{2,45}$/;

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The client address the proxy keys on: leftmost `X-Forwarded-For` entry,
 * else `X-Real-IP`; null when neither holds something shaped like an IP.
 */
export function clientIp(headers: HeaderSource): string | null {
  const candidates = [
    headers.get("x-forwarded-for")?.split(",")[0],
    headers.get("x-real-ip") ?? undefined,
  ];
  for (const raw of candidates) {
    let ip = raw?.trim() ?? "";
    if (ip.startsWith("[") && ip.includes("]")) {
      ip = ip.slice(1, ip.indexOf("]"));
    }
    ip = ip.split("%")[0] ?? "";
    if (IP_SHAPE.test(ip)) return ip.toLowerCase();
  }
  return null;
}

/**
 * Loopback, private (RFC 1918 / unique-local), link-local and unspecified
 * addresses. With no X-Forwarded-For at all, Next.js fills it from the TCP
 * peer before the proxy runs, so behind Traefik a missing header would show
 * up as Traefik's own (private) address; such an address names a hop, not a
 * client, and is treated as "no address" (not limited) rather than one
 * bucket for everybody.
 */
export function isNonRoutable(ip: string): boolean {
  const v = ip.toLowerCase();
  const v4 = v.startsWith("::ffff:") ? v.slice(7) : v;
  const parts = v4.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
    const [a = -1, b = -1] = parts;
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return (
    v === "::1" ||
    v === "::" ||
    /^f[cd][0-9a-f]{2}:/.test(v) ||
    /^fe[89ab][0-9a-f]:/.test(v)
  );
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets (>= 1), set when not allowed. */
  retryAfterSeconds: number;
  remaining: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter per key. Bounded: expired windows are pruned as it
 * goes, and past `maxKeys` the oldest windows are dropped (which can only
 * let a client through early, never block one wrongly).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();
  private calls = 0;

  constructor(private readonly maxKeys = 50_000) {}

  hit(key: string, rule: BucketRule, now: number): RateLimitDecision {
    this.calls++;
    if (this.calls % 1_000 === 0 || this.windows.size >= this.maxKeys) {
      this.prune(now);
    }
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + rule.windowMs };
      this.windows.delete(key);
      this.windows.set(key, w);
    }
    if (w.count >= rule.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
        remaining: 0,
      };
    }
    w.count++;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: rule.limit - w.count,
    };
  }

  get size(): number {
    return this.windows.size;
  }

  private prune(now: number): void {
    for (const [key, w] of this.windows) {
      if (w.resetAt <= now) this.windows.delete(key);
    }
    // Map iteration is insertion order: drop the oldest windows first.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}

/**
 * One decision for a request: null when the request is not limited (not a
 * limited route, or no client address: fail open).
 */
export function checkRateLimit(
  limiter: FixedWindowLimiter,
  input: { method: string; pathname: string; ip: string | null },
  now: number,
): (RateLimitDecision & { bucket: RateLimitBucket }) | null {
  const bucket = classifyRequest(input.method, input.pathname);
  if (bucket === null || input.ip === null || isNonRoutable(input.ip)) {
    return null;
  }
  const decision = limiter.hit(
    `${bucket}|${input.ip}`,
    RATE_LIMITS[bucket],
    now,
  );
  return { ...decision, bucket };
}

const TOO_MANY = "Too many requests. Please wait a minute and try again.";

/**
 * The tRPC response body for a refused call, in the shape the client's
 * superjson-transformed links parse (one entry per procedure when batched),
 * so the page shows a normal tRPC error instead of a parse failure.
 */
export function trpcTooManyRequestsBody(
  pathname: string,
  batched: boolean,
): unknown {
  const procedures = trpcProcedures(pathname);
  const one = (path: string | undefined) => ({
    error: {
      json: {
        message: TOO_MANY,
        code: -32029,
        data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, path },
      },
    },
  });
  return batched ? procedures.map((p) => one(p)) : one(procedures[0]);
}

export const TOO_MANY_REQUESTS_MESSAGE = TOO_MANY;
