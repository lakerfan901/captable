import { describe, expect, it } from "vitest";
import {
  classifySession,
  cookieName,
  cookieOptions,
  PLAIN_COOKIE_NAME,
  parseCookie,
  SECURE_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  sameOrigin,
  sessionExpiresAt,
  shouldTouch,
} from "./session-core";
import { newToken } from "./token-core";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A session created `ageMs` ago, last seen `idleMs` ago. */
function session(ageMs: number, idleMs: number, revokedAt: Date | null = null) {
  const createdAt = at(-ageMs);
  return {
    expiresAt: sessionExpiresAt(createdAt),
    lastSeenAt: at(-idleMs),
    revokedAt,
  };
}

describe("classifySession", () => {
  it("is OK for a fresh session", () => {
    expect(classifySession(session(0, 0), NOW)).toBe("OK");
  });

  it("last seen 24 h 1 s ago is IDLE; 24 h minus 1 ms is OK; exactly 24 h is IDLE", () => {
    expect(classifySession(session(2 * DAY, DAY + SECOND), NOW)).toBe("IDLE");
    expect(classifySession(session(2 * DAY, DAY - 1), NOW)).toBe("OK");
    expect(classifySession(session(2 * DAY, DAY), NOW)).toBe("IDLE");
  });

  it("created 7 days 1 s ago is EXPIRED; exactly 7 days is EXPIRED; 1 ms less is OK", () => {
    expect(classifySession(session(7 * DAY + SECOND, 0), NOW)).toBe("EXPIRED");
    expect(classifySession(session(7 * DAY, 0), NOW)).toBe("EXPIRED");
    expect(classifySession(session(7 * DAY - 1, 0), NOW)).toBe("OK");
  });

  it("precedence is REVOKED > EXPIRED > IDLE", () => {
    expect(classifySession(session(8 * DAY, 2 * DAY, at(-HOUR)), NOW)).toBe(
      "REVOKED",
    );
    expect(classifySession(session(8 * DAY, 2 * DAY), NOW)).toBe("EXPIRED");
    expect(classifySession(session(0, 0, at(HOUR)), NOW)).toBe("REVOKED");
  });

  it("a revocation in the future still revokes (any non-null value)", () => {
    expect(classifySession(session(0, 0, at(DAY)), NOW)).toBe("REVOKED");
  });

  it("fails closed on invalid or missing values", () => {
    const bad = new Date(Number.NaN);
    expect(classifySession({ ...session(0, 0), expiresAt: bad }, NOW)).toBe(
      "EXPIRED",
    );
    expect(classifySession({ ...session(0, 0), lastSeenAt: bad }, NOW)).toBe(
      "IDLE",
    );
    expect(classifySession(session(0, 0), bad)).not.toBe("OK");
    expect(
      classifySession(
        { ...session(0, 0), revokedAt: undefined as unknown as null },
        NOW,
      ),
    ).toBe("REVOKED");
  });

  it("a lastSeenAt in the future does not extend past the absolute end", () => {
    const row = { expiresAt: at(-1), lastSeenAt: at(DAY), revokedAt: null };
    expect(classifySession(row, NOW)).toBe("EXPIRED");
  });

  it("uses the plan's lengths", () => {
    expect(SESSION_MAX_AGE_MS).toBe(7 * DAY);
    expect(SESSION_IDLE_MS).toBe(DAY);
  });
});

describe("shouldTouch", () => {
  it("only after more than 5 minutes", () => {
    expect(shouldTouch(at(-5 * MINUTE), NOW)).toBe(false);
    expect(shouldTouch(at(-5 * MINUTE - 1), NOW)).toBe(true);
    expect(shouldTouch(at(-MINUTE), NOW)).toBe(false);
    expect(shouldTouch(at(MINUTE), NOW)).toBe(false);
  });

  it("refreshes an unreadable value", () => {
    expect(shouldTouch(new Date(Number.NaN), NOW)).toBe(true);
  });
});

describe("cookieName and cookieOptions", () => {
  it("uses the __Host- name only on https", () => {
    expect(cookieName("https://app.example.com")).toBe(SECURE_COOKIE_NAME);
    expect(cookieName("https://app.example.com/some/path")).toBe(
      SECURE_COOKIE_NAME,
    );
    expect(cookieName("HTTPS://APP.EXAMPLE.COM")).toBe(SECURE_COOKIE_NAME);
    expect(cookieName("http://localhost:3000")).toBe(PLAIN_COOKIE_NAME);
  });

  it("throws on a base URL that is not http(s)", () => {
    for (const bad of [
      "",
      "app.example.com",
      "ftp://x.test",
      "javascript:alert(1)",
      "//x.test",
    ]) {
      expect(() => cookieName(bad)).toThrow(RangeError);
    }
  });

  it("sets the attributes of 5.2", () => {
    expect(cookieOptions("https://app.example.com")).toEqual({
      name: "__Host-portal_session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    expect(cookieOptions("http://localhost:3000")).toMatchObject({
      name: "portal_session",
      secure: false,
    });
  });
});

describe("parseCookie", () => {
  const { token } = newToken();
  const other = newToken().token;
  const name = SECURE_COOKIE_NAME;

  it("reads the value among other cookies", () => {
    expect(parseCookie(`${name}=${token}`, name)).toBe(token);
    expect(parseCookie(`a=1; ${name}=${token}; b=2`, name)).toBe(token);
    expect(parseCookie(`a=1;${name}=${token};b=2`, name)).toBe(token);
    expect(parseCookie(`  ${name} = ${token}  `, name)).toBe(token);
    expect(parseCookie(`${name}="${token}"`, name)).toBe(token);
  });

  it("is null for a missing or empty header or name", () => {
    expect(parseCookie(null, name)).toBeNull();
    expect(parseCookie(undefined, name)).toBeNull();
    expect(parseCookie("", name)).toBeNull();
    expect(parseCookie("a=1; b=2", name)).toBeNull();
    expect(parseCookie(`${name}=${token}`, "")).toBeNull();
  });

  it("matches the name exactly", () => {
    expect(
      parseCookie(`x${PLAIN_COOKIE_NAME}=${token}`, PLAIN_COOKIE_NAME),
    ).toBeNull();
    expect(
      parseCookie(`${PLAIN_COOKIE_NAME}x=${token}`, PLAIN_COOKIE_NAME),
    ).toBeNull();
    expect(
      parseCookie(`${SECURE_COOKIE_NAME}=${token}`, PLAIN_COOKIE_NAME),
    ).toBeNull();
    expect(
      parseCookie(`${PLAIN_COOKIE_NAME}=${token}`, SECURE_COOKIE_NAME),
    ).toBeNull();
    expect(
      parseCookie(`__host-portal_session=${token}`, SECURE_COOKIE_NAME),
    ).toBeNull();
  });

  it("is null when the value is not a token", () => {
    expect(parseCookie(`${name}=`, name)).toBeNull();
    expect(parseCookie(`${name}=abc`, name)).toBeNull();
    expect(parseCookie(`${name}=${token}x`, name)).toBeNull();
    expect(
      parseCookie(
        `${name}=${encodeURIComponent(`${token.slice(0, 42)}+`)}`,
        name,
      ),
    ).toBeNull();
    expect(
      parseCookie(`${name}=eyJhbGciOiJIUzI1NiJ9.e30.sig`, name),
    ).toBeNull();
    expect(parseCookie(`${name}`, name)).toBeNull();
  });

  it("never URL-decodes the value", () => {
    const encoded = token.replace(/A/g, "%41");
    if (encoded !== token)
      expect(parseCookie(`${name}=${encoded}`, name)).toBeNull();
  });

  it("refuses two different values for the name (cookie tossing), accepts a repeat", () => {
    expect(parseCookie(`${name}=${token}; ${name}=${other}`, name)).toBeNull();
    expect(parseCookie(`${name}=${token}; ${name}=garbage`, name)).toBeNull();
    expect(parseCookie(`${name}=${token}; ${name}=${token}`, name)).toBe(token);
  });

  it("does not split on '=' inside the value", () => {
    expect(parseCookie(`${name}=${token}=`, name)).toBeNull();
  });
});

describe("sameOrigin", () => {
  const base = "https://app.example.com";

  it("accepts the exact origin", () => {
    expect(sameOrigin("https://app.example.com", base)).toBe(true);
    expect(
      sameOrigin("https://app.example.com", "https://app.example.com/"),
    ).toBe(true);
    expect(
      sameOrigin("https://app.example.com", "https://app.example.com/x?y"),
    ).toBe(true);
    expect(sameOrigin("https://app.example.com:443", base)).toBe(true);
    expect(sameOrigin("http://localhost:3000", "http://localhost:3000")).toBe(
      true,
    );
  });

  it.each([
    ["missing", undefined],
    ["null value", null],
    ["empty", ""],
    ["the string null", "null"],
    ["a foreign origin", "https://evil.example"],
    ["a suffix attack", "https://app.example.com.evil.test"],
    ["a prefix attack", "https://evilapp.example.com"],
    ["a subdomain", "https://x.app.example.com"],
    ["userinfo", "https://app.example.com@evil.test"],
    ["userinfo on the right host", "https://user@app.example.com"],
    ["a scheme swap", "http://app.example.com"],
    ["a different port", "https://app.example.com:8443"],
    ["a trailing slash", "https://app.example.com/"],
    ["a path", "https://app.example.com/portal"],
    ["a query", "https://app.example.com?x=1"],
    ["a fragment", "https://app.example.com#x"],
    ["a comma list", "https://app.example.com, https://evil.test"],
    ["a space list", "https://app.example.com https://evil.test"],
    ["surrounding whitespace", " https://app.example.com"],
    ["a trailing newline", "https://app.example.com\n"],
    ["a protocol-relative value", "//app.example.com"],
    ["a bare host", "app.example.com"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a file URL", "file:///etc/passwd"],
  ])("refuses %s", (_label, origin) => {
    expect(sameOrigin(origin as string | null | undefined, base)).toBe(false);
  });

  it("is false, never throws, for a bad base URL", () => {
    expect(sameOrigin("https://app.example.com", "")).toBe(false);
    expect(sameOrigin("https://app.example.com", "not a url")).toBe(false);
    expect(sameOrigin("null", "null")).toBe(false);
  });
});
