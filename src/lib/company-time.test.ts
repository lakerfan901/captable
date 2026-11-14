import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatInstant,
  formatInstantDate,
  resolveTimeZone,
  stripBakedTime,
  timeZoneNote,
  zoneAbbreviation,
} from "./company-time";

describe("formatInstant", () => {
  it("shows the instant in the company zone with its abbreviation", () => {
    // 2026-11-14T22:04Z is 3:04 PM in Denver (MST, UTC-7).
    expect(formatInstant("2026-11-14T22:04:00Z", "America/Denver")).toBe(
      "Nov 14, 2026, 3:04 PM MST",
    );
    expect(
      formatInstant(new Date("2026-07-01T06:30:00Z"), "America/Denver"),
    ).toBe("Jul 1, 2026, 12:30 AM MDT");
    expect(formatInstant("2026-07-01T16:05:00Z", "America/New_York")).toBe(
      "Jul 1, 2026, 12:05 PM EDT",
    );
  });

  it("crosses midnight in the company zone, not UTC", () => {
    // 02:00 UTC on Nov 15 is still Nov 14 in Denver.
    expect(formatInstant("2026-11-15T02:00:00Z", "America/Denver")).toBe(
      "Nov 14, 2026, 7:00 PM MST",
    );
  });

  it("falls back to the default zone for an empty or invalid zone", () => {
    expect(resolveTimeZone("")).toBe("America/Denver");
    expect(resolveTimeZone("Not/AZone")).toBe("America/Denver");
    expect(formatInstant("2026-11-14T22:04:00Z", null)).toBe(
      "Nov 14, 2026, 3:04 PM MST",
    );
  });

  it("returns a dash for an empty or invalid value", () => {
    expect(formatInstant(null, "America/Denver")).toBe("—");
    expect(formatInstant("nope", "America/Denver")).toBe("—");
  });
});

describe("formatInstantDate", () => {
  it("is the calendar date in the company zone", () => {
    expect(formatInstantDate("2026-11-15T02:00:00Z", "America/Denver")).toBe(
      "Nov 14, 2026",
    );
    expect(formatInstantDate("2026-11-15T02:00:00Z", "UTC")).toBe(
      "Nov 15, 2026",
    );
  });
});

describe("formatDate (date-only)", () => {
  it("never shifts a date-only value", () => {
    expect(formatDate("2026-11-30")).toBe("Nov 30, 2026");
    expect(formatDate(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "Jan 1, 2026",
    );
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-02-30")).toBe("—");
  });
});

describe("zone labels", () => {
  it("names the abbreviation in effect at the instant", () => {
    expect(zoneAbbreviation("2026-01-15T12:00:00Z", "America/Denver")).toBe(
      "MST",
    );
    expect(zoneAbbreviation("2026-07-15T12:00:00Z", "America/Denver")).toBe(
      "MDT",
    );
    expect(timeZoneNote("America/Denver", "2026-01-15T12:00:00Z")).toBe(
      "Times are shown in America/Denver (MST).",
    );
  });
});

describe("stripBakedTime", () => {
  it("drops the trailing dayjs 'lll' time of an e-sign summary", () => {
    expect(
      stripBakedTime(
        'Jane Doe signed "Exhibit B" on Chrome at Nov 14, 2026 3:04 PM',
      ),
    ).toBe('Jane Doe signed "Exhibit B" on Chrome');
    expect(
      stripBakedTime('"Exhibit B" completely signed at Jan 2, 2026 11:59 AM'),
    ).toBe('"Exhibit B" completely signed');
  });

  it("leaves any other summary untouched", () => {
    expect(stripBakedTime("Signed at the office")).toBe("Signed at the office");
    expect(stripBakedTime("")).toBe("");
  });
});
