import { describe, expect, it } from "vitest";
import { toWire } from "./wire";

describe("toWire", () => {
  it("converts cents to numbers and units to 6-dp strings", () => {
    expect(
      toWire({
        amount: 123456n,
        preferredUnits: 40000000n,
        lines: [{ gross: 5n, units: 10n }],
      }),
    ).toEqual({
      amount: 123456,
      preferredUnits: "40.000000",
      lines: [{ gross: 5, units: "0.000010" }],
    });
  });

  it("matches every units key case-insensitively, not perPreferredUnit", () => {
    expect(
      toWire({
        unitsBefore: 40000000n,
        unitsAfter: 10000000n,
        perPreferredUnit: 79384n,
      }),
    ).toEqual({
      unitsBefore: "40.000000",
      unitsAfter: "10.000000",
      perPreferredUnit: 79384,
    });
  });

  it("turns a Map into a plain object", () => {
    expect(toWire({ byKind: new Map([["WIND_DOWN", { total: 5n }]]) })).toEqual(
      { byKind: { WIND_DOWN: { total: 5 } } },
    );
  });

  it("converts a Prisma Decimal to a 6-dp string under any key", () => {
    const decimal = {
      d: [],
      e: 0,
      s: 1,
      toFixed: (_n: number) => "40.200000",
    };
    expect(toWire({ preferredUnits: decimal })).toEqual({
      preferredUnits: "40.200000",
    });
    expect(toWire({ anything: decimal })).toEqual({ anything: "40.200000" });
  });

  it("throws RangeError for a bigint beyond the safe range", () => {
    expect(() => toWire({ amount: 2n ** 60n })).toThrow(RangeError);
  });

  it("lets Map values, Set items and arrays inherit the parent key", () => {
    expect(
      toWire({
        commonUnits: new Map([["m", 100000000n]]),
        units: [1000000n],
        ids: new Set(["a", "b"]),
        amounts: new Set([7n]),
      }),
    ).toEqual({
      commonUnits: { m: "100.000000" },
      units: ["1.000000"],
      ids: ["a", "b"],
      amounts: [7],
    });
  });

  it("passes dates, strings, numbers, booleans and null through", () => {
    const at = new Date("2027-01-01T00:00:00.000Z");
    expect(toWire({ at, s: "x", n: 1, b: true, z: null, neg: -5n })).toEqual({
      at,
      s: "x",
      n: 1,
      b: true,
      z: null,
      neg: -5,
    });
  });
});
