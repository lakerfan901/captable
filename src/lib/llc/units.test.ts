import { describe, expect, it } from "vitest";
import {
  microUnitsForAmount,
  pctString,
  unitFractionMillionths,
  unitsForAmount,
} from "./units";

const P = 100000n;

describe("units", () => {
  it("unitsForAmount (FOUNDATION reference values first)", () => {
    expect(unitsForAmount(10000000n, P, true)).toBe("100.000000");
    expect(unitsForAmount(4020000n, P, true)).toBe("40.200000");
    expect(unitsForAmount(1234567n, P, true)).toBe("12.345670");
    expect(unitsForAmount(1n, P, true)).toBe("0.000010");
    expect(unitsForAmount(4020000n, P, false)).toBe("40.000000");
    expect(unitsForAmount(0n, P, true)).toBe("0.000000");
  });

  it("rejects bad input", () => {
    expect(() => unitsForAmount(-1n, P, true)).toThrow(
      expect.objectContaining({ code: "BAD_UNITS_INPUT" }),
    );
    expect(() => unitsForAmount(1n, 0n, true)).toThrow(
      expect.objectContaining({ code: "BAD_UNITS_INPUT" }),
    );
  });

  it("microUnitsForAmount", () => {
    expect(microUnitsForAmount(4000000n, P, true)).toBe(40000000n);
  });

  it("unitFractionMillionths and pctString", () => {
    expect(unitFractionMillionths(100000000n, 450000000n)).toBe(222222);
    expect(unitFractionMillionths(1n, 0n)).toBe(0);
    expect(pctString(100000000n, 450000000n)).toBe("22.2222");
    expect(pctString(1n, 0n)).toBe("0.0000");
  });
});
