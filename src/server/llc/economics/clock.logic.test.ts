import { describe, expect, it } from "vitest";
import { resolveEconomicsToday } from "./clock.logic";

// 2026-11-13 03:00 UTC is still 2026-11-12 in Denver (UTC−7).
const now = new Date("2026-11-13T03:00:00.000Z");
const timeZone = "America/Denver";

describe("resolveEconomicsToday", () => {
  it("uses the override outside production", () => {
    expect(
      resolveEconomicsToday({
        nodeEnv: "development",
        override: "2027-03-02",
        timeZone,
        now,
      }),
    ).toBe("2027-03-02");
    expect(
      resolveEconomicsToday({
        nodeEnv: undefined,
        override: "2027-01-14",
        timeZone,
        now,
      }),
    ).toBe("2027-01-14");
  });

  it("ignores the override in production", () => {
    expect(
      resolveEconomicsToday({
        nodeEnv: "production",
        override: "2027-03-02",
        timeZone,
        now,
      }),
    ).toBe("2026-11-12");
  });

  it("uses the company time zone without an override", () => {
    expect(
      resolveEconomicsToday({
        nodeEnv: "development",
        override: undefined,
        timeZone,
        now,
      }),
    ).toBe("2026-11-12");
    expect(
      resolveEconomicsToday({
        nodeEnv: "development",
        override: undefined,
        timeZone: "UTC",
        now,
      }),
    ).toBe("2026-11-13");
  });

  it("ignores an override that is not a valid date", () => {
    for (const override of ["", "2027-02-30", "tomorrow"]) {
      expect(
        resolveEconomicsToday({
          nodeEnv: "development",
          override,
          timeZone,
          now,
        }),
      ).toBe("2026-11-12");
    }
  });
});
