import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT_PATH, safeNextPath } from "./next-path";

describe("safeNextPath: kept", () => {
  it.each([
    "/portal/go/report/abc",
    "/portal/go/report/clx1abc2def3",
    "/portal/acc_123/reports/rep-456",
    "/portal/acc_123/financials?grain=quarter&range=since-inception",
    "/portal/account",
    "/portal/forgot-password",
    "/portal/sign-in-help",
    "/portal/x/",
    "/portal/a.b/c~d",
    "/portal/x/sign-in",
    "/portal/x/auth",
  ])("keeps %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it("keeps exactly 200 characters and refuses 201", () => {
    const p200 = `/portal/${"a".repeat(192)}`;
    expect(p200).toHaveLength(200);
    expect(safeNextPath(p200)).toBe(p200);
    expect(safeNextPath(`${p200}a`)).toBe(DEFAULT_NEXT_PATH);
  });
});

const REFUSED: [string, unknown][] = [
  // The plan's examples.
  ["protocol-relative", "//evil.example"],
  ["dot-dot", "/portal/../x"],
  ["the team login", "/login"],
  ["sign-out", "/portal/auth/sign-out"],
  ["an absolute URL", "https://evil.example/portal/"],
  // Not a string.
  ["undefined", undefined],
  ["null", null],
  ["a number", 1],
  ["an array (?next=a&next=b)", ["/portal/a", "/portal/b"]],
  ["an object", { toString: () => "/portal/x" }],
  // Outside /portal/.
  ["empty", ""],
  ["the root", "/"],
  ["/portal itself", "/portal"],
  ["a sibling prefix", "/portalx/a"],
  ["a sibling prefix with dash", "/portal-evil/a"],
  ["upper case", "/Portal/a"],
  ["a relative path", "portal/a"],
  ["a team page", "/abc123/stakeholders"],
  ["a token page", "/member-reports/eyJhbGciOi"],
  ["an api path", "/api/trpc/portal.me"],
  // Scheme and host tricks.
  ["protocol-relative to /portal", "//evil.example/portal/x"],
  ["triple slash", "///evil.example/portal/"],
  ["a backslash host", "/\\evil.example"],
  ["backslash in portal", "/portal/\\evil.example"],
  ["double slash inside", "/portal//evil.example"],
  ["a javascript URL", "javascript:alert(1)"],
  ["a data URL", "data:text/html,<script>alert(1)</script>"],
  ["http scheme", "http://evil.example"],
  ["a colon", "/portal/x:y"],
  ["userinfo", "/portal/@evil.example"],
  ["an at sign", "/portal/x@evil.example"],
  // Dot segments.
  ["a dot segment", "/portal/./x"],
  ["a trailing dot-dot", "/portal/x/.."],
  ["a trailing dot", "/portal/x/."],
  ["dot-dot to auth", "/portal/x/../auth/sign-out"],
  // Encodings.
  ["encoded slash", "/portal/%2f%2fevil.example"],
  ["encoded dot-dot", "/portal/%2e%2e/login"],
  ["mixed encoded dot-dot", "/portal/.%2e/login"],
  ["encoded backslash", "/portal/%5cevil.example"],
  ["double-encoded slash", "/portal/%252f%252fevil"],
  ["an encoded tab", "/portal/%09/x"],
  ["encoded sign-in", "/portal/%73ign-in"],
  // Control and whitespace characters.
  ["a tab", "/portal/\tx"],
  ["a newline", "/portal/x\n"],
  ["a CR LF", "/portal/x\r\nSet-Cookie: a=b"],
  ["NUL", "/portal/x\u0000"],
  ["a leading space", " /portal/x"],
  ["a trailing space", "/portal/x "],
  ["a space", "/portal/a b"],
  // Non-ASCII look-alikes.
  ["a fullwidth slash", "/portal/／／evil.example"],
  ["a fullwidth solidus start", "／portal/x"],
  ["a unicode dot", "/portal/\u2024\u2024/x"],
  ["a right-to-left mark", "/portal/\u200fx"],
  ["an accented letter", "/portal/é"],
  // Denied first segments.
  ["the auth root", "/portal/auth"],
  ["auth sign-in", "/portal/auth/sign-in"],
  ["auth set-password", "/portal/auth/set-password"],
  [
    "set-password with a token",
    "/portal/set-password/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  ],
  ["set-password root", "/portal/set-password"],
  ["sign-in", "/portal/sign-in"],
  ["sign-in with a next", "/portal/sign-in?next=/portal/x"],
  ["sign-in with a trailing slash", "/portal/sign-in/"],
  // Other.
  ["a fragment", "/portal/x#y"],
  ["a plus", "/portal/x+y"],
  ["a percent alone", "/portal/100%"],
  ["a semicolon", "/portal/x;y"],
  ["quotes", '/portal/"x"'],
  ["angle brackets", "/portal/<script>"],
];

describe("safeNextPath: refused", () => {
  it.each(REFUSED)("refuses %s", (_label, value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it("any result resolves on the same origin to exactly itself under /portal", () => {
    const base = "https://app.example.com";
    const corpus = [
      ...REFUSED.map(([, v]) => v),
      "/portal/go/report/abc",
      "/portal/a?b=c",
    ];
    for (const value of corpus) {
      const result = safeNextPath(value);
      const url = new URL(result, base);
      expect(url.origin).toBe(base);
      expect(url.pathname + url.search).toBe(result);
      expect(result === "/portal" || result.startsWith("/portal/")).toBe(true);
    }
  });

  it("refuses very long inputs at the length check", () => {
    expect(safeNextPath(`/portal/${"./".repeat(10_000)}`)).toBe(
      DEFAULT_NEXT_PATH,
    );
    expect(safeNextPath("/".repeat(100_000))).toBe(DEFAULT_NEXT_PATH);
  });
});
