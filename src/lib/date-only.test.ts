import { describe, expect, test } from "vitest";
import {
  diffInDays,
  formatDateOnly,
  fromDateOnly,
  isValidDateOnly,
  isValidTimeZone,
  toDateOnly,
  todayInTimeZone,
} from "./date-only";

describe("date-only", () => {
  const instant = new Date("2026-12-01T02:30:00Z");

  test("today in Denver is still Nov 30", () =>
    expect(todayInTimeZone("America/Denver", instant)).toBe("2026-11-30"));
  test("today in UTC is Dec 1", () =>
    expect(todayInTimeZone("UTC", instant)).toBe("2026-12-01"));
  test("diffInDays", () =>
    expect(diffInDays("2026-11-12", "2026-11-30")).toBe(18));
  test("rejects Feb 30", () =>
    expect(isValidDateOnly("2026-02-30")).toBe(false));
  test("round trip", () =>
    expect(toDateOnly(fromDateOnly("2027-03-31"))).toBe("2027-03-31"));
  test("format", () =>
    expect(formatDateOnly("2026-11-30")).toBe("Nov 30, 2026"));
  test("invalid time zone", () =>
    expect(isValidTimeZone("Mars/Olympus")).toBe(false));
});
