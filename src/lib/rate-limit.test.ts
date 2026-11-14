import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  classifyRequest,
  clientIp,
  FixedWindowLimiter,
  isNonRoutable,
  RATE_LIMITS,
  trpcProcedures,
  trpcTooManyRequestsBody,
} from "./rate-limit";

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe("clientIp", () => {
  it("takes the leftmost X-Forwarded-For entry", () => {
    expect(
      clientIp(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP", () => {
    expect(clientIp(headers({ "x-real-ip": "2001:db8::1" }))).toBe(
      "2001:db8::1",
    );
  });

  it("normalises bracketed and zone-suffixed IPv6", () => {
    expect(clientIp(headers({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe(
      "2001:db8::1",
    );
    expect(clientIp(headers({ "x-forwarded-for": "fe80::1%eth0" }))).toBe(
      "fe80::1",
    );
  });

  it("is null when there is no usable address (the request is not limited)", () => {
    expect(clientIp(headers({}))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": "unknown" }))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": " " }))).toBeNull();
  });

  it("skips a malformed X-Forwarded-For in favour of X-Real-IP", () => {
    expect(
      clientIp(
        headers({ "x-forwarded-for": "<script>", "x-real-ip": "198.51.100.4" }),
      ),
    ).toBe("198.51.100.4");
  });
});

describe("classifyRequest", () => {
  it("limits credential and passkey sign-in POSTs only", () => {
    expect(classifyRequest("POST", "/api/auth/callback/credentials")).toBe(
      "login",
    );
    expect(classifyRequest("POST", "/api/auth/callback/webauthn")).toBe(
      "login",
    );
    expect(classifyRequest("GET", "/api/auth/callback/credentials")).toBeNull();
    expect(classifyRequest("GET", "/api/auth/session")).toBeNull();
    expect(classifyRequest("GET", "/api/auth/csrf")).toBeNull();
    expect(classifyRequest("POST", "/api/auth/callback/google")).toBeNull();
  });

  it("limits the public account procedures, batched or not", () => {
    expect(classifyRequest("POST", "/api/trpc/auth.signup")).toBe("account");
    expect(
      classifyRequest("POST", "/api/trpc/auth.forgotPassword,common.x"),
    ).toBe("account");
    expect(classifyRequest("POST", "/api/trpc/auth.newPassword")).toBe(
      "account",
    );
    expect(
      classifyRequest("POST", "/api/trpc/passkey.createSigninOptions"),
    ).toBe("account");
  });

  it("limits the public token procedures (also URL-encoded batches)", () => {
    expect(classifyRequest("GET", "/api/trpc/ballot.view")).toBe("token-api");
    expect(
      classifyRequest("GET", "/api/trpc/memberReportView.view%2CballoT.x"),
    ).toBe("token-api");
    expect(classifyRequest("POST", "/api/trpc/template.sign")).toBe(
      "token-api",
    );
    expect(classifyRequest("GET", "/api/trpc/admission.w9Info")).toBe(
      "token-api",
    );
  });

  it("does not limit authenticated procedures", () => {
    expect(classifyRequest("GET", "/api/trpc/company.getCompany")).toBeNull();
    expect(classifyRequest("POST", "/api/trpc/admission.send")).toBeNull();
    expect(classifyRequest("GET", "/api/trpc/template.get")).toBeNull();
  });

  it("limits the emailed-link pages, not their bare prefixes or other pages", () => {
    for (const p of [
      "/esign/abc.def.ghi",
      "/w9/tok",
      "/ballots/tok",
      "/member-reports/tok",
      "/verify-member/tok",
      "/verify-email/tok",
      "/reset-password/tok",
      "/set-password/tok",
      "/data-rooms/pub",
      "/updates/pub",
    ]) {
      expect(classifyRequest("GET", p)).toBe("token-page");
    }
    expect(classifyRequest("GET", "/esign/")).toBeNull();
    expect(classifyRequest("GET", "/login")).toBeNull();
    expect(classifyRequest("GET", "/abc123/updates/x")).toBeNull();
    expect(classifyRequest("GET", "/api/health")).toBeNull();
  });
});

describe("trpcProcedures", () => {
  it("splits batched paths", () => {
    expect(trpcProcedures("/api/trpc/a.b,c.d")).toEqual(["a.b", "c.d"]);
    expect(trpcProcedures("/api/trpc/a.b%2Cc.d")).toEqual(["a.b", "c.d"]);
    expect(trpcProcedures("/esign/x")).toEqual([]);
    expect(trpcProcedures("/api/trpc/%E0%A4%A")).toEqual(["%E0%A4%A"]);
  });
});

describe("FixedWindowLimiter", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("allows `limit` hits per window, then refuses with Retry-After, then recovers", () => {
    const l = new FixedWindowLimiter();
    const t0 = 1_000_000;
    expect(l.hit("k", rule, t0).remaining).toBe(2);
    expect(l.hit("k", rule, t0 + 1).allowed).toBe(true);
    expect(l.hit("k", rule, t0 + 2).allowed).toBe(true);
    const refused = l.hit("k", rule, t0 + 20_000);
    expect(refused).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
      remaining: 0,
    });
    expect(l.hit("k", rule, t0 + 59_999).retryAfterSeconds).toBe(1);
    expect(l.hit("k", rule, t0 + 60_000).allowed).toBe(true);
  });

  it("counts keys independently", () => {
    const l = new FixedWindowLimiter();
    for (let i = 0; i < 3; i++) l.hit("a", rule, 0);
    expect(l.hit("a", rule, 0).allowed).toBe(false);
    expect(l.hit("b", rule, 0).allowed).toBe(true);
  });

  it("stays bounded, dropping the oldest windows first", () => {
    const l = new FixedWindowLimiter(100);
    for (let i = 0; i < 1_000; i++) l.hit(`k${i}`, rule, 0);
    expect(l.size).toBeLessThanOrEqual(100);
    // The newest key is still counted.
    expect(l.hit("k999", rule, 0).remaining).toBe(1);
  });

  it("prunes expired windows", () => {
    const l = new FixedWindowLimiter(10);
    for (let i = 0; i < 10; i++) l.hit(`k${i}`, rule, 0);
    l.hit("late", rule, 120_000);
    expect(l.size).toBe(1);
  });
});

describe("isNonRoutable", () => {
  it("flags loopback, private, link-local and unspecified addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.1",
      "::1",
      "::",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.1.1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "FEBF::1",
      "::ffff:10.1.2.3",
    ]) {
      expect(isNonRoutable(ip), ip).toBe(true);
    }
  });

  it("does not flag public addresses", () => {
    for (const ip of [
      "203.0.113.7",
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "2001:db8::1",
      "2606:4700::1111",
      "fc::1",
      "fec0::1",
      "::ffff:8.8.8.8",
    ]) {
      expect(isNonRoutable(ip), ip).toBe(false);
    }
  });
});

describe("checkRateLimit", () => {
  it("is null (fail open) without a client address", () => {
    const l = new FixedWindowLimiter();
    for (let i = 0; i < 100; i++) {
      expect(
        checkRateLimit(
          l,
          {
            method: "POST",
            pathname: "/api/auth/callback/credentials",
            ip: null,
          },
          0,
        ),
      ).toBeNull();
    }
  });

  it("is null (fail open) for a loopback / private peer, which names a proxy hop", () => {
    const l = new FixedWindowLimiter();
    for (const ip of [
      "::1",
      "127.0.0.1",
      "10.0.1.5",
      "172.18.0.3",
      "::ffff:192.168.1.9",
    ]) {
      for (let i = 0; i < 100; i++) {
        expect(
          checkRateLimit(
            l,
            { method: "POST", pathname: "/api/auth/callback/credentials", ip },
            0,
          ),
        ).toBeNull();
      }
    }
  });

  it("is null for routes that are not limited", () => {
    const l = new FixedWindowLimiter();
    expect(
      checkRateLimit(l, { method: "GET", pathname: "/", ip: "1.2.3.4" }, 0),
    ).toBeNull();
  });

  it("refuses the login after the limit for that IP only", () => {
    const l = new FixedWindowLimiter();
    const req = (ip: string) => ({
      method: "POST",
      pathname: "/api/auth/callback/credentials",
      ip,
    });
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      expect(checkRateLimit(l, req("1.2.3.4"), 0)?.allowed).toBe(true);
    }
    expect(checkRateLimit(l, req("1.2.3.4"), 0)).toMatchObject({
      allowed: false,
      bucket: "login",
      retryAfterSeconds: 60,
    });
    expect(checkRateLimit(l, req("5.6.7.8"), 0)?.allowed).toBe(true);
  });

  it("keeps the token-page and login buckets apart", () => {
    const l = new FixedWindowLimiter();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      checkRateLimit(
        l,
        {
          method: "POST",
          pathname: "/api/auth/callback/credentials",
          ip: "1.1.1.1",
        },
        0,
      );
    }
    expect(
      checkRateLimit(
        l,
        { method: "GET", pathname: "/esign/tok", ip: "1.1.1.1" },
        0,
      )?.allowed,
    ).toBe(true);
  });

  it("limits are loose enough for an office behind one address", () => {
    expect(RATE_LIMITS.login.limit).toBeGreaterThanOrEqual(20);
    expect(RATE_LIMITS["token-page"].limit).toBeGreaterThan(
      RATE_LIMITS.login.limit,
    );
  });
});

describe("trpcTooManyRequestsBody", () => {
  it("has one tRPC error per batched procedure", () => {
    const body = trpcTooManyRequestsBody(
      "/api/trpc/ballot.view,ballot.markViewed",
      true,
    ) as { error: { json: { code: number; data: { path: string } } } }[];
    expect(body).toHaveLength(2);
    expect(body[0]?.error.json.code).toBe(-32029);
    expect(body[1]?.error.json.data.path).toBe("ballot.markViewed");
  });

  it("is a single error when not batched", () => {
    expect(trpcTooManyRequestsBody("/api/trpc/auth.signup", false)).toEqual({
      error: {
        json: expect.objectContaining({
          code: -32029,
          data: {
            code: "TOO_MANY_REQUESTS",
            httpStatus: 429,
            path: "auth.signup",
          },
        }),
      },
    });
  });
});
