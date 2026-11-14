import { describe, expect, it } from "vitest";
import {
  fiscalYearBounds,
  holderIdsFromSnapshots,
  holdingCheckDates,
  k1Coverage,
} from "./k1-coverage";

describe("holdingCheckDates", () => {
  it("the first day of the year plus the ledger dates inside it", () => {
    expect(fiscalYearBounds(2026)).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
    expect(
      holdingCheckDates(2026, [
        "2025-12-31",
        "2026-06-30",
        "2026-01-01",
        "2026-03-15",
        "2026-06-30",
        "2026-12-31",
        "2027-01-01",
      ]),
    ).toEqual(["2026-01-01", "2026-03-15", "2026-06-30", "2026-12-31"]);
  });
});

describe("holderIdsFromSnapshots", () => {
  it("anyone with units > 0 in any snapshot (a holder who transferred out mid-year counts)", () => {
    const jan = [
      { stakeholderId: "a", units: "100.000000" },
      { stakeholderId: "t", units: "50.000000" },
    ];
    const jul = [
      { stakeholderId: "a", units: "100.000000" },
      { stakeholderId: "t", units: "0.000000" },
      { stakeholderId: "b", units: "0.000001" },
      { stakeholderId: "z", units: "0" },
    ];
    expect([...holderIdsFromSnapshots([jan, jul])].sort()).toEqual([
      "a",
      "b",
      "t",
    ]);
  });
});

describe("k1Coverage", () => {
  const needed = [
    { stakeholderId: "b", name: "Bea" },
    { stakeholderId: "a", name: "Al" },
    { stakeholderId: "f", name: "Fay (Financial Interest only)" },
  ];
  it("one K-1 out of three is NOT complete (the old rule said done)", () => {
    const c = k1Coverage(2026, needed, new Set(["a"]));
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual(["Bea", "Fay (Financial Interest only)"]);
    expect(c.needed.map((n) => [n.name, n.delivered])).toEqual([
      ["Al", true],
      ["Bea", false],
      ["Fay (Financial Interest only)", false],
    ]);
  });
  it("complete when every holder of the year has a delivered K-1 (extra recipients do not matter)", () => {
    const c = k1Coverage(2026, needed, new Set(["a", "b", "f", "x"]));
    expect(c.complete).toBe(true);
    expect(c.missing).toEqual([]);
  });
  it("a K-1 queued but not yet emailed does not count", () => {
    const c = k1Coverage(2026, needed, new Set(["a", "f"]), new Set(["b"]));
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual(["Bea"]);
    expect(c.needed.find((n) => n.stakeholderId === "b")).toMatchObject({
      delivered: false,
      queued: true,
    });
    expect(c.needed.find((n) => n.stakeholderId === "a")?.queued).toBe(false);
  });
  it("a year with no holder is never completed by a report", () => {
    expect(k1Coverage(2026, [], new Set(["a"])).complete).toBe(false);
  });
});
