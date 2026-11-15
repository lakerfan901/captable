import { describe, expect, it } from "vitest";
import {
  lastWholeMonth,
  MAX_RESTATE_MONTHS,
  monthsToSnapshot,
  nextVersion,
  restateRangeProblem,
  seriesInception,
} from "./financial-snapshot-core";
import { generateWorld } from "./fixtures/series-world";

describe("lastWholeMonth", () => {
  it("is the month of a month-end date", () => {
    expect(lastWholeMonth("2026-03-31")).toBe("2026-03-01");
    expect(lastWholeMonth("2028-02-29")).toBe("2028-02-01");
    expect(lastWholeMonth("2026-12-31")).toBe("2026-12-01");
  });
  it("is the month before when the date is not a month end", () => {
    expect(lastWholeMonth("2026-03-30")).toBe("2026-02-01");
    expect(lastWholeMonth("2026-01-01")).toBe("2025-12-01");
  });
});

describe("monthsToSnapshot", () => {
  it("starts at inception without any snapshot", () => {
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: null,
        inception: "2026-01-01",
        periodEnd: "2026-03-31",
      }),
    ).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
  it("fills an unreleased quarter after the latest snapshot (Q3 after Q1: six months)", () => {
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: "2026-03-01",
        inception: "2026-01-01",
        periodEnd: "2026-09-30",
      }),
    ).toEqual([
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
  });
  it("writes nothing for a period already covered (annual after Q4, Q2 after Q3)", () => {
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: "2026-12-01",
        inception: "2026-01-01",
        periodEnd: "2026-12-31",
      }),
    ).toEqual([]);
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: "2026-09-01",
        inception: "2026-01-01",
        periodEnd: "2026-06-30",
      }),
    ).toEqual([]);
  });
  it("writes nothing when the ledger has no row, or starts after the period", () => {
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: null,
        inception: null,
        periodEnd: "2026-09-30",
      }),
    ).toEqual([]);
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: null,
        inception: "2026-11-01",
        periodEnd: "2026-09-30",
      }),
    ).toEqual([]);
  });
  it("starts in the middle of a quarter when inception does", () => {
    expect(
      monthsToSnapshot({
        latestSnapshotMonth: null,
        inception: "2026-02-01",
        periodEnd: "2026-03-31",
      }),
    ).toEqual(["2026-02-01", "2026-03-01"]);
  });
});

describe("seriesInception", () => {
  it("is the month of the earliest dated row of a generated world", () => {
    for (const seed of [1, 7, 42]) {
      const w = generateWorld(seed);
      expect(seriesInception(w.input)).toBe(w.inception);
    }
  });
  it("is moved earlier by an extra date and is null for an empty input", () => {
    const w = generateWorld(3);
    expect(seriesInception(w.input, ["2025-06-15"])).toBe("2025-06-01");
    const empty = {
      ...w.input,
      economics: {
        ...w.input.economics,
        ledger: {
          months: [],
          expenses: [],
          reserves: [],
          defaultIncome: [],
          loanPayments: [],
          loanProceeds: [],
          distributions: [],
          capitalReceived: [],
        },
        managerPayments: [],
        distributions: [],
      },
      events: [],
      memberLoans: [],
      holders: [],
    };
    expect(seriesInception(empty)).toBeNull();
    expect(seriesInception(empty, ["2027-02-03"])).toBe("2027-02-01");
  });
});

describe("restateRangeProblem", () => {
  const ok = {
    fromMonth: "2026-02-01",
    toMonth: "2026-03-01",
    firstSnapshotMonth: "2026-01-01",
    latestSnapshotMonth: "2026-06-01",
    inception: "2026-01-01",
    today: "2026-10-05",
  };
  it("accepts published, ended months", () => {
    expect(restateRangeProblem(ok)).toBeNull();
    expect(
      restateRangeProblem({
        ...ok,
        fromMonth: "2026-06-01",
        toMonth: "2026-06-01",
      }),
    ).toBeNull();
  });
  it("refuses malformed or reversed months", () => {
    expect(restateRangeProblem({ ...ok, fromMonth: "2026-02-02" })).toMatch(
      /first day/,
    );
    expect(
      restateRangeProblem({
        ...ok,
        fromMonth: "2026-04-01",
        toMonth: "2026-03-01",
      }),
    ).toMatch(/must not be after/);
  });
  it("refuses months after the latest snapshot, and everything without one", () => {
    expect(restateRangeProblem({ ...ok, toMonth: "2026-07-01" })).toMatch(
      /latest is 2026-06/,
    );
    expect(
      restateRangeProblem({
        ...ok,
        firstSnapshotMonth: null,
        latestSnapshotMonth: null,
      }),
    ).toMatch(/nothing to restate/);
  });
  it("refuses months before the first snapshot and inception (no empty rows)", () => {
    expect(
      restateRangeProblem({
        ...ok,
        fromMonth: "2018-01-01",
        toMonth: "2026-01-01",
      }),
    ).toMatch(/no figures before 2026-01/);
    expect(
      restateRangeProblem({
        ...ok,
        inception: null,
        fromMonth: "2025-12-01",
        toMonth: "2026-01-01",
      }),
    ).toMatch(/no figures before 2026-01/);
  });
  it("allows back-dated months before the first snapshot only up to it", () => {
    const back = { ...ok, inception: "2025-11-01" };
    expect(
      restateRangeProblem({
        ...back,
        fromMonth: "2025-11-01",
        toMonth: "2025-12-01",
      }),
    ).toBeNull();
    expect(
      restateRangeProblem({
        ...back,
        fromMonth: "2025-11-01",
        toMonth: "2026-02-01",
      }),
    ).toBeNull();
    expect(
      restateRangeProblem({
        ...back,
        fromMonth: "2025-11-01",
        toMonth: "2025-11-01",
      }),
    ).toMatch(/must run up to it/);
    expect(
      restateRangeProblem({
        ...back,
        fromMonth: "2025-10-01",
        toMonth: "2025-12-01",
      }),
    ).toMatch(/no figures before 2025-11/);
  });
  it("refuses a month that has not ended", () => {
    expect(
      restateRangeProblem({
        ...ok,
        toMonth: "2026-06-01",
        today: "2026-06-30",
      }),
    ).toMatch(/ended/);
  });
  it("refuses more than the maximum number of months", () => {
    expect(
      restateRangeProblem({
        ...ok,
        fromMonth: "2010-01-01",
        toMonth: "2026-01-01",
        firstSnapshotMonth: "2010-01-01",
      }),
    ).toMatch(new RegExp(String(MAX_RESTATE_MONTHS)));
  });
});

describe("nextVersion", () => {
  it("is one more than any existing row, 1 for none", () => {
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([1])).toBe(2);
    expect(nextVersion([2, 1, 3])).toBe(4);
  });
});
