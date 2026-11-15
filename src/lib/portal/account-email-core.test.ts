import { describe, expect, it } from "vitest";
import {
  expiryPhrase,
  PORTAL_EMAIL_LOG_KIND,
  portalEmailSubject,
  utcInstant,
} from "./account-email-core";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const plus = (ms: number) => new Date(NOW.getTime() + ms);

describe("expiryPhrase", () => {
  it("names a fresh invitation link 7 days, also minutes after issue", () => {
    expect(expiryPhrase(plus(7 * 86_400_000), NOW)).toBe("7 days");
    expect(expiryPhrase(plus(7 * 86_400_000 - 9 * 60_000), NOW)).toBe("7 days");
    expect(expiryPhrase(plus(6 * 86_400_000 + 12 * 3_600_000), NOW)).toBe(
      "6 days",
    );
  });
  it("names a fresh reset link 60 minutes, even a few ms after minting", () => {
    expect(expiryPhrase(plus(60 * 60_000 - 5), NOW)).toBe("60 minutes");
  });
  it("rounds days and hours down, minutes up", () => {
    expect(expiryPhrase(plus(6 * 86_400_000 + 23 * 3_600_000), NOW)).toBe(
      "6 days",
    );
    expect(expiryPhrase(plus(47 * 3_600_000 + 30 * 60_000), NOW)).toBe(
      "47 hours",
    );
    expect(expiryPhrase(plus(121 * 60_000), NOW)).toBe("2 hours");
    expect(expiryPhrase(plus(90_001), NOW)).toBe("2 minutes");
    expect(expiryPhrase(plus(30_000), NOW)).toBe("1 minute");
  });
  it("never promises time for a past or invalid expiry", () => {
    expect(expiryPhrase(plus(-1), NOW)).toBe("a few minutes");
    expect(expiryPhrase(new Date(Number.NaN), NOW)).toBe("a few minutes");
  });
});

describe("portalEmailSubject", () => {
  it("names the company or holder when known", () => {
    expect(portalEmailSubject("INVITE", { companyName: "Acme LLC" })).toBe(
      "You have been invited to the Acme LLC investor portal",
    );
    expect(
      portalEmailSubject("ACCESS_ADDED", { holderName: "Bexley Trust" }),
    ).toBe("You now have access to Bexley Trust");
  });
  it("has a neutral fallback without names", () => {
    expect(portalEmailSubject("INVITE")).toBe(
      "You have been invited to the investor portal",
    );
    expect(portalEmailSubject("ACCESS_ADDED")).toMatch(/investor portal$/);
  });
  it("carries no link or token in any subject", () => {
    for (const kind of Object.keys(PORTAL_EMAIL_LOG_KIND)) {
      const subject = portalEmailSubject(
        kind as keyof typeof PORTAL_EMAIL_LOG_KIND,
        { companyName: "C", holderName: "H" },
      );
      expect(subject).not.toMatch(/https?:|\/portal\//);
    }
  });
});

describe("PORTAL_EMAIL_LOG_KIND", () => {
  it("uses the mail kinds of the plan (5.6)", () => {
    expect(Object.values(PORTAL_EMAIL_LOG_KIND).sort()).toEqual([
      "portal.access-added",
      "portal.account-locked",
      "portal.invite",
      "portal.password-changed",
      "portal.password-reset",
    ]);
  });
});

describe("utcInstant", () => {
  it("formats in UTC with a 24-hour time", () => {
    expect(utcInstant(new Date("2026-11-15T17:32:09Z"))).toBe(
      "November 15, 2026 at 17:32 UTC",
    );
    expect(utcInstant(new Date("2026-01-02T00:05:00Z"))).toBe(
      "January 2, 2026 at 00:05 UTC",
    );
  });
});
