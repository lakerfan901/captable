import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  businessDaysBetween,
  isBusinessDay,
  nextBusinessDay,
  usFederalHolidays,
} from "./business-days";

describe("usFederalHolidays", () => {
  it("2027 observed dates", () => {
    expect(usFederalHolidays(2027).map((h) => h.observedOn)).toEqual([
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-10-11",
      "2027-11-11",
      "2027-11-25",
      "2027-12-24",
    ]);
  });

  it("2026 Independence Day", () => {
    const h = usFederalHolidays(2026).find(
      (x) => x.name === "Independence Day",
    );
    expect(h).toMatchObject({ date: "2026-07-04", observedOn: "2026-07-03" });
  });

  it("2028", () => {
    const h = usFederalHolidays(2028);
    expect(h).toHaveLength(11);
    expect(h.map((x) => x.observedOn)).toEqual([
      "2027-12-31",
      "2028-01-17",
      "2028-02-21",
      "2028-05-29",
      "2028-06-19",
      "2028-07-04",
      "2028-09-04",
      "2028-10-09",
      "2028-11-10",
      "2028-11-23",
      "2028-12-25",
    ]);
  });
});

describe("isBusinessDay", () => {
  it.each([
    ["2027-06-18", false],
    ["2027-06-19", false],
    ["2027-12-31", false],
    ["2027-11-11", false],
    ["2027-01-19", true],
  ])("%s → %s", (d, expected) => {
    expect(isBusinessDay(d)).toBe(expected);
  });

  it("options", () => {
    expect(
      isBusinessDay("2027-06-18", { saturdayObservedOnFriday: false }),
    ).toBe(true);
    expect(isBusinessDay("2027-01-18", { holidays: "NONE" })).toBe(true);
    expect(isBusinessDay("2027-03-10", { extraHolidays: ["2027-03-10"] })).toBe(
      false,
    );
  });
});

describe("addBusinessDays", () => {
  it.each<[string, number, string]>([
    ["2027-01-14", 3, "2027-01-20"],
    ["2027-01-16", 3, "2027-01-21"],
    ["2027-01-20", 5, "2027-01-27"],
    ["2027-01-20", 1, "2027-01-21"],
    ["2027-03-29", 3, "2027-04-01"],
    ["2027-03-26", 3, "2027-03-31"],
    ["2027-03-31", 5, "2027-04-07"],
    ["2026-11-25", 3, "2026-12-01"],
    ["2026-12-23", 3, "2026-12-29"],
    ["2027-12-23", 3, "2027-12-29"],
    ["2027-12-30", 1, "2028-01-03"],
    ["2027-06-17", 1, "2027-06-21"],
    ["2027-07-02", 1, "2027-07-06"],
    ["2027-01-19", -1, "2027-01-15"],
    ["2026-11-16", 10, "2026-12-01"],
    ["2026-11-16", 5, "2026-11-23"],
    ["2027-02-15", 10, "2027-03-01"],
    ["2027-01-16", 0, "2027-01-16"],
    // FOUNDATION reference values (01-foundation.md E2.1)
    ["2026-11-02", 10, "2026-11-17"],
    ["2026-11-17", 5, "2026-11-24"],
    ["2026-11-20", 10, "2026-12-07"],
    ["2026-12-07", 5, "2026-12-14"],
    ["2026-11-12", 10, "2026-11-27"],
  ])("(%s, %i) → %s", (d, n, expected) => {
    expect(addBusinessDays(d, n)).toBe(expected);
  });

  it("nextBusinessDay", () => {
    expect(nextBusinessDay("2027-01-20")).toBe("2027-01-21");
  });
});

describe("businessDaysBetween", () => {
  it("counts (from, to]", () => {
    expect(businessDaysBetween("2027-01-14", "2027-01-20")).toBe(3);
    expect(businessDaysBetween("2027-01-15", "2027-01-19")).toBe(1);
    expect(businessDaysBetween("2027-01-20", "2027-01-14")).toBe(0);
  });
});
