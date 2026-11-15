import { describe, expect, it } from "vitest";
import { resetRequestAllowed } from "./throttle-core";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("resetRequestAllowed", () => {
  it("allows the first three inside 15 minutes and refuses the fourth", () => {
    expect(resetRequestAllowed([], NOW)).toBe(true);
    expect(resetRequestAllowed([ago(MINUTE)], NOW)).toBe(true);
    expect(resetRequestAllowed([ago(MINUTE), ago(2 * MINUTE)], NOW)).toBe(true);
    expect(
      resetRequestAllowed([ago(MINUTE), ago(2 * MINUTE), ago(3 * MINUTE)], NOW),
    ).toBe(false);
  });

  it("a token created exactly 15 minutes ago no longer counts toward the short window", () => {
    expect(
      resetRequestAllowed(
        [ago(MINUTE), ago(2 * MINUTE), ago(15 * MINUTE)],
        NOW,
      ),
    ).toBe(true);
    expect(
      resetRequestAllowed(
        [ago(MINUTE), ago(2 * MINUTE), ago(15 * MINUTE - 1)],
        NOW,
      ),
    ).toBe(false);
  });

  it("refuses the eleventh inside 24 hours even when spread out", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ago((i + 1) * 2 * HOUR));
    expect(resetRequestAllowed(ten.slice(0, 9), NOW)).toBe(true);
    expect(
      resetRequestAllowed(
        ten.slice(0, 10).map((d, i) => (i === 9 ? ago(23 * HOUR) : d)),
        NOW,
      ),
    ).toBe(false);
  });

  it("a token created exactly 24 hours ago no longer counts", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ago((i + 1) * 2 * HOUR));
    expect(resetRequestAllowed([...nine, ago(24 * HOUR)], NOW)).toBe(true);
    expect(resetRequestAllowed([...nine, ago(24 * HOUR - 1)], NOW)).toBe(false);
  });

  it("ignores old tokens", () => {
    const old = Array.from({ length: 50 }, (_, i) =>
      ago(25 * HOUR + i * MINUTE),
    );
    expect(resetRequestAllowed(old, NOW)).toBe(true);
  });

  it("counts future and unreadable timestamps against the request (fail closed)", () => {
    const future = new Date(NOW.getTime() + HOUR);
    expect(resetRequestAllowed([future, future, future], NOW)).toBe(false);
    const bad = new Date(Number.NaN);
    expect(resetRequestAllowed([bad, bad, bad], NOW)).toBe(false);
    expect(resetRequestAllowed([bad, bad], NOW)).toBe(true);
  });
});
