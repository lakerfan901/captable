import { describe, expect, it } from "vitest";
import { todayInTimeZone } from "../date-only";
import { lastEndedQuarter } from "./last-ended-quarter";

describe("lastEndedQuarter", () => {
  it("is the previous quarter within the year", () => {
    expect(lastEndedQuarter("2026-11-14")).toEqual({ year: 2026, quarter: 3 });
    expect(lastEndedQuarter("2026-10-01")).toEqual({ year: 2026, quarter: 3 });
    expect(lastEndedQuarter("2026-09-30")).toEqual({ year: 2026, quarter: 2 });
    expect(lastEndedQuarter("2026-04-01")).toEqual({ year: 2026, quarter: 1 });
  });

  it("is Q4 of the prior year in the first quarter", () => {
    expect(lastEndedQuarter("2027-01-01")).toEqual({ year: 2026, quarter: 4 });
    expect(lastEndedQuarter("2027-03-31")).toEqual({ year: 2026, quarter: 4 });
  });

  it("follows the company's date, not UTC", () => {
    // 05:00 UTC on Oct 1 is still Sep 30 in Denver: Q3 has not ended there.
    const now = new Date("2026-10-01T05:00:00Z");
    expect(lastEndedQuarter(todayInTimeZone("America/Denver", now))).toEqual({
      year: 2026,
      quarter: 2,
    });
    expect(lastEndedQuarter(todayInTimeZone("UTC", now))).toEqual({
      year: 2026,
      quarter: 3,
    });
  });
});
