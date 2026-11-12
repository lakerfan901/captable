import { describe, expect, it } from "vitest";
import {
  centsToDecimalString,
  LlcMathError,
  microUnitsFromDecimal,
  microUnitsToDecimalString,
  roundDiv,
} from "./money";

describe("money", () => {
  it("roundDiv", () => {
    expect(roundDiv(5n, 10n)).toBe(1n);
    expect(roundDiv(4n, 10n)).toBe(0n);
    expect(roundDiv(-5n, 10n)).toBe(-1n);
    expect(roundDiv(15n, 10n)).toBe(2n);
    expect(() => roundDiv(1n, 0n)).toThrow(LlcMathError);
    expect(() => roundDiv(1n, 0n)).toThrow(
      expect.objectContaining({ code: "BAD_DIVISOR" }),
    );
  });

  it("centsToDecimalString", () => {
    expect(centsToDecimalString(123456n)).toBe("1234.56");
    expect(centsToDecimalString(-5n)).toBe("-0.05");
    expect(centsToDecimalString(0n)).toBe("0.00");
  });

  it("microUnitsFromDecimal", () => {
    expect(microUnitsFromDecimal("12.345670")).toBe(12345670n);
    expect(microUnitsFromDecimal({ toString: () => "100" })).toBe(100000000n);
    expect(() => microUnitsFromDecimal("1.2345678")).toThrow(
      expect.objectContaining({ code: "BAD_UNITS" }),
    );
  });

  it("microUnitsToDecimalString", () => {
    expect(microUnitsToDecimalString(12345670n)).toBe("12.345670");
    expect(microUnitsToDecimalString(-30000000n)).toBe("-30.000000");
  });
});
