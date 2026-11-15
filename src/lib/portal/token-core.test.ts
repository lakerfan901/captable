import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashToken,
  isTokenHashShape,
  isTokenShape,
  newToken,
  RESET_PASSWORD_TTL_MS,
  SET_PASSWORD_TTL_MS,
  TOKEN_LENGTH,
  tokenExpiresAt,
  tokenHashesEqual,
  tokenUsable,
} from "./token-core";

const NOW = new Date("2026-11-15T12:00:00.000Z");

describe("newToken", () => {
  it("makes a 43-character base64url token and its SHA-256 hex", () => {
    const { token, hash } = newToken();
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isTokenShape(token)).toBe(true);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(isTokenHashShape(hash)).toBe(true);
  });

  it("is deterministic for injected bytes and decodes back to them", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const { token, hash } = newToken(() => bytes);
    expect(Buffer.from(token, "base64url")).toEqual(Buffer.from(bytes));
    expect(newToken(() => bytes)).toEqual({ token, hash });
  });

  it("encodes all-zero and all-0xff bytes to valid shapes", () => {
    for (const fill of [0x00, 0xff]) {
      const { token } = newToken(() => new Uint8Array(32).fill(fill));
      expect(isTokenShape(token)).toBe(true);
    }
  });

  it("refuses a source that returns the wrong number of bytes", () => {
    expect(() => newToken(() => new Uint8Array(31))).toThrow(RangeError);
    expect(() => newToken(() => new Uint8Array(33))).toThrow(RangeError);
    expect(() => newToken(() => new Uint8Array(0))).toThrow(RangeError);
  });

  it("produces distinct tokens from the real source", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newToken().token);
    expect(seen.size).toBe(200);
  });

  it("every 32-byte value has the strict shape (property over random inputs)", () => {
    for (let i = 0; i < 500; i++) {
      const bytes = randomBytes(32);
      expect(isTokenShape(newToken(() => bytes).token)).toBe(true);
    }
  });
});

describe("hashToken", () => {
  it("hashes the string, not the decoded bytes", () => {
    const { token } = newToken();
    expect(hashToken(token)).toBe(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
    expect(hashToken(token)).not.toBe(
      createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("hex"),
    );
  });

  it("differs for tokens that differ in one character", () => {
    const { token } = newToken(() => new Uint8Array(32));
    const other = `B${token.slice(1)}`;
    expect(hashToken(token)).not.toBe(hashToken(other));
  });

  it("hashes unicode and empty input without throwing", () => {
    expect(isTokenHashShape(hashToken(""))).toBe(true);
    expect(isTokenHashShape(hashToken("é🙂"))).toBe(true);
  });
});

describe("isTokenShape", () => {
  const good = newToken(() => new Uint8Array(32).fill(7)).token;

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { token: good }],
    ["empty", ""],
    ["42 characters", good.slice(0, 42)],
    ["44 characters", `${good}A`],
    ["padding", `${good.slice(0, 42)}=`],
    ["standard base64 +", `+${good.slice(1)}`],
    ["standard base64 /", `/${good.slice(1)}`],
    ["a dot", `.${good.slice(1)}`],
    ["leading space", ` ${good.slice(1)}`],
    ["trailing newline", `${good.slice(0, 42)}\n`],
    ["percent-encoded", `%41${good.slice(3)}`],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJwIjoibXIifQ.c2lnbmF0dXJl"],
    ["a 64-char hash", "a".repeat(64)],
    ["a fullwidth letter", `Ａ${good.slice(1)}`],
  ])("refuses %s", (_label, value) => {
    expect(isTokenShape(value)).toBe(false);
  });

  it("refuses a last character that carries non-zero padding bits", () => {
    // 32 bytes leave 2 unused bits in the last character: B (000001) is impossible.
    expect(isTokenShape(`${good.slice(0, 42)}B`)).toBe(false);
    expect(isTokenShape(`${good.slice(0, 42)}A`)).toBe(true);
  });
});

describe("tokenHashesEqual", () => {
  const a = hashToken("one");
  const b = hashToken("two");

  it("is true for equal hashes and false for different ones", () => {
    expect(tokenHashesEqual(a, a)).toBe(true);
    expect(tokenHashesEqual(a, `${a}`)).toBe(true);
    expect(tokenHashesEqual(a, b)).toBe(false);
  });

  it("is false, never throws, for malformed or different-length values", () => {
    expect(tokenHashesEqual(a, a.slice(1))).toBe(false);
    expect(tokenHashesEqual(a, `${a}0`)).toBe(false);
    expect(tokenHashesEqual(a.toUpperCase(), a.toUpperCase())).toBe(false);
    expect(tokenHashesEqual("", "")).toBe(false);
    expect(tokenHashesEqual(null, null)).toBe(false);
    expect(tokenHashesEqual(undefined, a)).toBe(false);
  });
});

describe("expiry", () => {
  it("is 7 days for an invitation and 60 minutes for a reset", () => {
    expect(SET_PASSWORD_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(RESET_PASSWORD_TTL_MS).toBe(60 * 60 * 1000);
    expect(tokenExpiresAt("SET_PASSWORD", NOW).toISOString()).toBe(
      "2026-11-22T12:00:00.000Z",
    );
    expect(tokenExpiresAt("RESET_PASSWORD", NOW).toISOString()).toBe(
      "2026-11-15T13:00:00.000Z",
    );
  });

  it("throws on an unknown purpose", () => {
    expect(() => tokenExpiresAt("MAGIC" as never, NOW)).toThrow(RangeError);
  });

  it("tokenUsable: unused and strictly before expiry", () => {
    const expiresAt = tokenExpiresAt("RESET_PASSWORD", NOW);
    expect(tokenUsable({ expiresAt, usedAt: null }, NOW)).toBe(true);
    expect(
      tokenUsable(
        { expiresAt, usedAt: null },
        new Date(expiresAt.getTime() - 1),
      ),
    ).toBe(true);
    expect(tokenUsable({ expiresAt, usedAt: null }, expiresAt)).toBe(false);
    expect(
      tokenUsable(
        { expiresAt, usedAt: null },
        new Date(expiresAt.getTime() + 1),
      ),
    ).toBe(false);
    expect(tokenUsable({ expiresAt, usedAt: NOW }, NOW)).toBe(false);
  });

  it("tokenUsable fails closed on invalid dates and a missing usedAt", () => {
    expect(
      tokenUsable({ expiresAt: new Date(Number.NaN), usedAt: null }, NOW),
    ).toBe(false);
    const expiresAt = tokenExpiresAt("SET_PASSWORD", NOW);
    expect(tokenUsable({ expiresAt, usedAt: null }, new Date(Number.NaN))).toBe(
      false,
    );
    expect(
      tokenUsable({ expiresAt, usedAt: undefined as unknown as null }, NOW),
    ).toBe(false);
  });
});
