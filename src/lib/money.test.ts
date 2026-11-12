import { describe, expect, test } from "vitest";
import {
  centsToNumber,
  formatCents,
  mulBpsCeil,
  mulDivRoundHalfUp,
  parseDollarsToCents,
} from "./money";

describe("parseDollarsToCents", () => {
  test.each([
    ["100,000", 10000000n],
    ["$100,000.00", 10000000n],
    [" 250000 ", 25000000n],
    ["1000.5", 100050n],
  ])("%j -> %s", (input, expected) => {
    expect(parseDollarsToCents(input)).toBe(expected);
  });

  test.each(["100.005", "-5", "abc", ""])("%j -> null", (input) => {
    expect(parseDollarsToCents(input)).toBeNull();
  });
});

describe("formatCents", () => {
  test("zero", () => expect(formatCents(0)).toBe("$0.00"));
  test("thousands", () =>
    expect(formatCents(123456789n)).toBe("$1,234,567.89"));
  test("negative", () => expect(formatCents(-4000000n)).toBe("-$40,000.00"));
});

describe("arithmetic", () => {
  test("mulBpsCeil exact", () =>
    expect(mulBpsCeil(25000000n, 4000)).toBe(10000000n));
  test("mulBpsCeil rounds up", () =>
    expect(mulBpsCeil(10000001n, 4000)).toBe(4000001n));
  test("mulDivRoundHalfUp exact", () =>
    expect(mulDivRoundHalfUp(8000000n, 10000000n, 20000000n)).toBe(4000000n));
  test("mulDivRoundHalfUp half rounds up", () =>
    expect(mulDivRoundHalfUp(1n, 1n, 2n)).toBe(1n));
  test("centsToNumber throws beyond safe range", () =>
    expect(() => centsToNumber(2n ** 60n)).toThrow(RangeError));
});
