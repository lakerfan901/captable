import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  addYears,
  compareIso,
  dayOfWeek,
  daysBetween,
  isIsoDate,
  maxIso,
  minIso,
  quarterOf,
} from "./dates";

describe("dates", () => {
  it("daysBetween", () => {
    expect(daysBetween("2026-11-16", "2027-02-14")).toBe(90);
    expect(daysBetween("2027-12-31", "2028-12-31")).toBe(366);
    expect(daysBetween("2027-02-14", "2026-11-16")).toBe(-90);
  });

  it("addDays", () => {
    expect(addDays("2027-01-20", 30)).toBe("2027-02-19");
    expect(addDays("2027-03-31", 45)).toBe("2027-05-15");
  });

  it("addMonths", () => {
    expect(addMonths("2032-02-15", -9)).toBe("2031-05-15");
    expect(addMonths("2031-11-30", -9)).toBe("2031-02-28");
    expect(addMonths("2032-05-31", -9)).toBe("2031-08-31");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("addYears", () => {
    expect(addYears("2028-02-29", 5)).toBe("2033-02-28");
    expect(addYears("2027-02-15", 5)).toBe("2032-02-15");
  });

  it("isIsoDate", () => {
    expect(isIsoDate("2027-02-30")).toBe(false);
    expect(isIsoDate("2027-2-3")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });

  it("dayOfWeek", () => {
    expect(dayOfWeek("2027-03-31")).toBe(3);
  });

  it("quarterOf", () => {
    expect(quarterOf("2027-12-31")).toEqual({
      year: 2027,
      quarter: 4,
      start: "2027-10-01",
      end: "2027-12-31",
    });
    expect(quarterOf("2027-05-14")).toEqual({
      year: 2027,
      quarter: 2,
      start: "2027-04-01",
      end: "2027-06-30",
    });
  });

  it("compareIso, minIso, maxIso", () => {
    expect(compareIso("2027-01-01", "2027-01-02")).toBe(-1);
    expect(compareIso("2027-01-02", "2027-01-02")).toBe(0);
    expect(compareIso("2027-01-03", "2027-01-02")).toBe(1);
    expect(minIso("2027-03-31", "2027-01-20", "2027-02-01")).toBe("2027-01-20");
    expect(maxIso("2027-03-31", "2027-01-20", "2027-02-01")).toBe("2027-03-31");
  });
});
