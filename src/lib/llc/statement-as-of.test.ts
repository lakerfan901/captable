import { describe, expect, it } from "vitest";
import { statementAsOf, statementQuarters } from "./statement-as-of";

describe("statementAsOf", () => {
  const today = "2026-11-14";
  it("defaults to today", () => {
    expect(statementAsOf(undefined, today)).toBe(today);
    expect(statementAsOf("", today)).toBe(today);
    expect(statementAsOf(["2026-01-01"], today)).toBe(today);
  });
  it("keeps a real past date", () => {
    expect(statementAsOf("2026-09-30", today)).toBe("2026-09-30");
    expect(statementAsOf(today, today)).toBe(today);
  });
  it("refuses malformed, impossible, future and too-early dates", () => {
    expect(statementAsOf("2026-9-30", today)).toBe(today);
    expect(statementAsOf("2026-02-30", today)).toBe(today);
    expect(statementAsOf("2026-11-15", today)).toBe(today);
    expect(statementAsOf("1999-12-31", today)).toBe(today);
  });
});

describe("statementQuarters", () => {
  it("as of today: the current quarter cut at today and three before (unchanged)", () => {
    expect(statementQuarters("2026-11-14")).toEqual([
      {
        key: "2026-Q4",
        label: "Q4 2026",
        from: "2026-10-01",
        to: "2026-11-14",
      },
      {
        key: "2026-Q3",
        label: "Q3 2026",
        from: "2026-07-01",
        to: "2026-09-30",
      },
      {
        key: "2026-Q2",
        label: "Q2 2026",
        from: "2026-04-01",
        to: "2026-06-30",
      },
      {
        key: "2026-Q1",
        label: "Q1 2026",
        from: "2026-01-01",
        to: "2026-03-31",
      },
    ]);
  });
  it("as of a quarter end: that quarter whole", () => {
    expect(statementQuarters("2026-09-30")[0]).toEqual({
      key: "2026-Q3",
      label: "Q3 2026",
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(statementQuarters("2026-09-30")[3]?.key).toBe("2025-Q4");
  });
});
