import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { COMMON_PASSWORD_LIST } from "./common-passwords";
import {
  BCRYPT_COST,
  COMMON_PASSWORDS,
  checkPassword,
  emailNames,
  isLocked,
  LOCK_MS,
  lockNoticeDue,
  PASSWORD_PROBLEM_MESSAGES,
  signInOutcome,
  utf8ByteLength,
} from "./password-core";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const EMAIL = "jsmith@x.test";
const GOOD = "correct horse battery";

describe("checkPassword: length", () => {
  it("accepts a long passphrase", () => {
    expect(checkPassword(GOOD, EMAIL)).toEqual({ ok: true });
  });

  it("refuses 11 characters and accepts 12", () => {
    expect(checkPassword("Zq8!vT2#mLp", EMAIL)).toEqual({
      ok: false,
      reason: "TOO_SHORT",
    });
    expect(checkPassword("Zq8!vT2#mLpW", EMAIL)).toEqual({ ok: true });
  });

  it("counts characters as code points: 11 emoji are too short, 12 are enough", () => {
    expect(checkPassword("🙂".repeat(11), EMAIL)).toEqual({
      ok: false,
      reason: "TOO_SHORT",
    });
    expect(checkPassword("🙂".repeat(12), EMAIL)).toEqual({ ok: true }); // 48 bytes
  });

  it("refuses 30 three-byte characters (90 bytes) for length in bytes", () => {
    const pw = "€".repeat(30);
    expect(utf8ByteLength(pw)).toBe(90);
    expect(checkPassword(pw, EMAIL)).toEqual({ ok: false, reason: "TOO_LONG" });
  });

  it("accepts exactly 72 bytes and refuses 73", () => {
    const base = "k7#Vq".repeat(14); // 70 ASCII bytes
    expect(checkPassword(`${base}xy`, EMAIL)).toEqual({ ok: true });
    expect(checkPassword(`${base}xyz`, EMAIL)).toEqual({
      ok: false,
      reason: "TOO_LONG",
    });
    expect(checkPassword(`${base}é`, EMAIL)).toEqual({ ok: true }); // 72 bytes
    expect(checkPassword(`${base}x€`, EMAIL)).toEqual({
      ok: false,
      reason: "TOO_LONG",
    }); // 74
  });

  it("18 four-byte emoji are exactly 72 bytes; 19 are refused", () => {
    expect(utf8ByteLength("🙂".repeat(18))).toBe(72);
    expect(checkPassword("🙂".repeat(18), EMAIL)).toEqual({ ok: true });
    expect(checkPassword("🙂".repeat(19), EMAIL)).toEqual({
      ok: false,
      reason: "TOO_LONG",
    });
  });

  it("72 plain characters are allowed, 73 are not (byte rule = character rule for ASCII)", () => {
    expect(checkPassword("a1b2c3d4e5f6".repeat(6), EMAIL)).toEqual({
      ok: true,
    });
    expect(checkPassword(`${"a1b2c3d4e5f6".repeat(6)}g`, EMAIL)).toEqual({
      ok: false,
      reason: "TOO_LONG",
    });
  });

  it("matches Buffer.byteLength, which bcrypt's truncation rule uses", () => {
    for (const s of ["", "abc", "é", "€", "🙂", "a🙂b€é", "\u{10FFFF}"]) {
      expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, "utf8"));
    }
  });

  it("refuses for length exactly when bcryptjs would truncate", () => {
    const samples = [
      "a".repeat(72),
      "a".repeat(73),
      "🙂".repeat(18),
      "🙂".repeat(19),
      "€".repeat(24),
      "€".repeat(25),
      `${"é".repeat(36)}`,
      `${"é".repeat(36)}x`,
      `${"k7#Vq".repeat(14)}x€`,
    ];
    for (const pw of samples) {
      const tooLong =
        checkPassword(pw, EMAIL).ok === false &&
        (checkPassword(pw, EMAIL) as { reason: string }).reason === "TOO_LONG";
      expect(tooLong).toBe(bcrypt.truncates(pw));
    }
  });

  it("does not trim: spaces count toward the length", () => {
    expect(checkPassword("  v8#qLm2!z  ", EMAIL)).toEqual({ ok: true }); // 13 characters
    expect(checkPassword("           x", EMAIL)).toEqual({ ok: true });
  });
});

describe("checkPassword: characters", () => {
  it.each([
    ["NUL", "abcdefghijk\u0000lm"],
    ["a newline", "abcdefghijk\nlm"],
    ["a tab", "abcdefghijk\tlm"],
    ["DEL", "abcdefghijk\u007flm"],
    ["a C1 control", "abcdefghijk\u0085lm"],
    ["a line separator", "abcdefghijk\u2028lm"],
    ["a lone high surrogate", "abcdefghijk\ud83dlm"],
    ["a lone low surrogate", "abcdefghijk\ude42lm"],
    ["a reversed surrogate pair", "abcdefghijk\ude42\ud83dlm"],
  ])("refuses %s", (_label, pw) => {
    expect(checkPassword(pw, EMAIL)).toEqual({
      ok: false,
      reason: "INVALID_CHARACTERS",
    });
  });

  it("accepts accented letters, CJK and a paired surrogate", () => {
    expect(checkPassword("Grüße aus Köln!", EMAIL)).toEqual({ ok: true });
    expect(checkPassword("パスワードは長くて安全です", EMAIL)).toEqual({
      ok: true,
    });
    expect(checkPassword("cat🐈dog🐕bird🐦", EMAIL)).toEqual({ ok: true });
  });

  it("refuses a non-string", () => {
    for (const v of [undefined, null, 123456789012, ["a".repeat(12)], {}]) {
      expect(checkPassword(v, EMAIL)).toEqual({
        ok: false,
        reason: "NOT_A_STRING",
      });
    }
  });
});

describe("checkPassword: common passwords", () => {
  it("refuses password1234 (common), in any case", () => {
    expect(checkPassword("password1234", EMAIL)).toEqual({
      ok: false,
      reason: "COMMON",
    });
    expect(checkPassword("PassWord1234", EMAIL)).toEqual({
      ok: false,
      reason: "COMMON",
    });
    expect(checkPassword("qwerty123456", EMAIL)).toEqual({
      ok: false,
      reason: "COMMON",
    });
  });

  it("refuses a common password padded with spaces", () => {
    expect(checkPassword(" password1234 ", EMAIL)).toEqual({
      ok: false,
      reason: "COMMON",
    });
  });

  it("the bundled list has 1,000 distinct lower-case entries a password could be", () => {
    expect(COMMON_PASSWORD_LIST).toHaveLength(1000);
    expect(COMMON_PASSWORDS.size).toBe(1000);
    for (const p of COMMON_PASSWORD_LIST) {
      expect(p).toBe(p.toLowerCase());
      expect([...p].length).toBeGreaterThanOrEqual(12);
      expect(p).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("every list entry under 72 bytes is refused as COMMON (or for the email name)", () => {
    for (const p of COMMON_PASSWORD_LIST) {
      const r = checkPassword(p, "nobody@x.test");
      if (utf8ByteLength(p) <= 72)
        expect(r).toEqual({ ok: false, reason: "COMMON" });
      else expect(r).toEqual({ ok: false, reason: "TOO_LONG" });
    }
  });
});

describe("checkPassword: email name", () => {
  it("refuses a password containing jsmith for jsmith@x.test, in any case", () => {
    expect(checkPassword("hello-jsmith-2026", EMAIL)).toEqual({
      ok: false,
      reason: "CONTAINS_EMAIL_NAME",
    });
    expect(checkPassword("hello-JSmith-2026", EMAIL)).toEqual({
      ok: false,
      reason: "CONTAINS_EMAIL_NAME",
    });
    expect(checkPassword("hello-jsmith-2026", "  JSmith@X.TEST ")).toEqual({
      ok: false,
      reason: "CONTAINS_EMAIL_NAME",
    });
  });

  it("ignores an email name shorter than 4 characters", () => {
    expect(checkPassword("bob-likes-long-walks", "bob@x.test")).toEqual({
      ok: true,
    });
    expect(checkPassword("jo-likes-long-walks", "jo@x.test")).toEqual({
      ok: true,
    });
    expect(checkPassword("anna-likes-long-walks", "anna@x.test")).toEqual({
      ok: false,
      reason: "CONTAINS_EMAIL_NAME",
    });
  });

  it("also refuses the name before a +tag", () => {
    expect(emailNames("jsmith+portal@x.test")).toEqual([
      "jsmith+portal",
      "jsmith",
    ]);
    expect(checkPassword("hello-jsmith-2026", "jsmith+portal@x.test")).toEqual({
      ok: false,
      reason: "CONTAINS_EMAIL_NAME",
    });
  });

  it("uses the part before the last @ and survives odd input", () => {
    expect(emailNames('"a@b"@x.test')).toEqual(['"a@b"']);
    expect(emailNames("")).toEqual([]);
    expect(emailNames("@x.test")).toEqual([]);
    expect(emailNames("noatsign")).toEqual(["noatsign"]);
  });

  it("does not refuse the domain", () => {
    expect(checkPassword("example-rocks-2026", "jo@example.com")).toEqual({
      ok: true,
    });
  });
});

describe("messages and cost", () => {
  it("has a message for every reason and cost 12", () => {
    for (const reason of [
      "NOT_A_STRING",
      "TOO_SHORT",
      "TOO_LONG",
      "INVALID_CHARACTERS",
      "COMMON",
      "CONTAINS_EMAIL_NAME",
    ] as const) {
      expect(PASSWORD_PROBLEM_MESSAGES[reason].length).toBeGreaterThan(0);
    }
    expect(BCRYPT_COST).toBe(12);
  });
});

describe("signInOutcome (P6)", () => {
  const fresh = { lockedUntil: null, failedSignIns: 0 };

  it("four wrong passwords do not lock; the fifth locks for 15 minutes", () => {
    let state: { lockedUntil: Date | null; failedSignIns: number } = fresh;
    for (let i = 1; i <= 4; i++) {
      const r = signInOutcome(state, false, NOW);
      expect(r).toEqual({
        result: "REFUSED",
        failedSignIns: i,
        lockedUntil: null,
        lockedNow: false,
      });
      state = r;
    }
    const fifth = signInOutcome(state, false, NOW);
    expect(fifth.result).toBe("REFUSED");
    expect(fifth.lockedNow).toBe(true);
    expect(fifth.failedSignIns).toBe(0);
    expect(fifth.lockedUntil?.toISOString()).toBe(at(LOCK_MS).toISOString());
    expect(LOCK_MS).toBe(15 * 60 * 1000);
  });

  it("refuses the right password during the lock and leaves the state unchanged", () => {
    const locked = { lockedUntil: at(LOCK_MS), failedSignIns: 0 };
    const r = signInOutcome(locked, true, at(LOCK_MS - 1));
    expect(r).toEqual({
      result: "REFUSED",
      failedSignIns: 0,
      lockedUntil: locked.lockedUntil,
      lockedNow: false,
    });
  });

  it("wrong passwords during the lock neither count nor extend it", () => {
    let state: { lockedUntil: Date | null; failedSignIns: number } = {
      lockedUntil: at(LOCK_MS),
      failedSignIns: 0,
    };
    for (let i = 0; i < 20; i++) {
      const r = signInOutcome(state, false, at(i * 1000));
      expect(r.lockedNow).toBe(false);
      expect(r.lockedUntil).toBe(state.lockedUntil);
      expect(r.failedSignIns).toBe(0);
      state = r;
    }
  });

  it("is OK one second after the lock ends, with the counter at 0", () => {
    const locked = { lockedUntil: at(LOCK_MS), failedSignIns: 0 };
    expect(signInOutcome(locked, true, at(LOCK_MS + 1000))).toEqual({
      result: "OK",
      failedSignIns: 0,
      lockedUntil: null,
      lockedNow: false,
    });
  });

  it("the lock ends exactly at lockedUntil (lockedUntil > now refuses)", () => {
    const locked = { lockedUntil: at(LOCK_MS), failedSignIns: 0 };
    expect(signInOutcome(locked, true, at(LOCK_MS)).result).toBe("OK");
    expect(isLocked(locked.lockedUntil, at(LOCK_MS))).toBe(false);
    expect(isLocked(locked.lockedUntil, at(LOCK_MS - 1))).toBe(true);
  });

  it("a wrong password after an ended lock starts a new count and clears the lock", () => {
    const ended = { lockedUntil: at(-1), failedSignIns: 0 };
    expect(signInOutcome(ended, false, NOW)).toEqual({
      result: "REFUSED",
      failedSignIns: 1,
      lockedUntil: null,
      lockedNow: false,
    });
  });

  it("a success resets the counter", () => {
    expect(
      signInOutcome({ lockedUntil: null, failedSignIns: 4 }, true, NOW),
    ).toEqual({
      result: "OK",
      failedSignIns: 0,
      lockedUntil: null,
      lockedNow: false,
    });
  });

  it("locks at 5 or more (a counter pushed past 4 by concurrent requests)", () => {
    for (const n of [4, 5, 9, 1000]) {
      const r = signInOutcome(
        { lockedUntil: null, failedSignIns: n },
        false,
        NOW,
      );
      expect(r.lockedNow).toBe(true);
      expect(r.failedSignIns).toBe(0);
    }
  });

  it("reads a negative, fractional or NaN counter as 0", () => {
    for (const n of [-3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = signInOutcome(
        { lockedUntil: null, failedSignIns: n },
        false,
        NOW,
      );
      expect(r).toMatchObject({ failedSignIns: 1, lockedNow: false });
    }
  });

  it("treats an unreadable lockedUntil as locked (fail closed)", () => {
    const bad = { lockedUntil: new Date(Number.NaN), failedSignIns: 0 };
    expect(signInOutcome(bad, true, NOW).result).toBe("REFUSED");
    expect(isLocked(bad.lockedUntil, NOW)).toBe(true);
  });

  it("only a literal true matches", () => {
    expect(signInOutcome(fresh, "true" as unknown as boolean, NOW).result).toBe(
      "REFUSED",
    );
    expect(signInOutcome(fresh, 1 as unknown as boolean, NOW).result).toBe(
      "REFUSED",
    );
  });

  it("isLocked is false without a lock", () => {
    expect(isLocked(null, NOW)).toBe(false);
  });
});

describe("lockNoticeDue", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("is due when never sent or at least 24 hours ago", () => {
    expect(lockNoticeDue(null, NOW)).toBe(true);
    expect(lockNoticeDue(at(-DAY), NOW)).toBe(true);
    expect(lockNoticeDue(at(-DAY - 1), NOW)).toBe(true);
    expect(lockNoticeDue(at(-DAY + 1), NOW)).toBe(false);
    expect(lockNoticeDue(at(-1000), NOW)).toBe(false);
  });

  it("is not due for a future or unreadable timestamp", () => {
    expect(lockNoticeDue(at(DAY), NOW)).toBe(false);
    expect(lockNoticeDue(new Date(Number.NaN), NOW)).toBe(false);
  });
});
