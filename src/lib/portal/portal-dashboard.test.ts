import { describe, expect, it } from "vitest";
import type { DashboardPeriod } from "../llc/financial-dashboard-core";
import type { HolderMonth } from "../llc/financial-series";
import {
  contributionRows,
  dashboardPeriodOfReport,
  distributionRows,
  financialsHref,
  latestPeriodReport,
  newestDocuments,
  reportFinancialsHref,
  reportHref,
  reportsForPeriod,
} from "./portal-dashboard";

const ACCESS = "pa_0123456789abcdef";

const q = (
  key: string,
  start: string,
  end: string,
  reportId: string | null,
): DashboardPeriod => ({ key, grain: "quarter", start, end, reportId });
const y = (
  key: string,
  start: string,
  end: string,
  reportId: string | null,
): DashboardPeriod => ({ key, grain: "year", start, end, reportId });

const PERIODS: DashboardPeriod[] = [
  q("2025-Q3", "2025-07-01", "2025-09-30", "rep_q3"),
  q("2025-Q4", "2025-10-01", "2025-12-31", "rep_q4"),
  y("2025", "2025-01-01", "2025-12-31", "rep_fy25"),
  q("2026-Q1", "2026-01-01", "2026-03-31", null),
  q("2026-Q2", "2026-04-01", "2026-06-30", "rep_q2/x"),
];

const REPORTS = [
  {
    id: "rep_q4",
    title: "Q4 2025 report to Members",
    releasedOn: "2026-01-29",
  },
  { id: "rep_fy25", title: "Annual report 2025", releasedOn: "2026-02-20" },
];

describe("links", () => {
  it("builds the report URL with the access and an encoded report id", () => {
    expect(reportHref(ACCESS, "rep_q2/x")).toBe(
      `/portal/${ACCESS}/reports/rep_q2%2Fx`,
    );
  });

  it("opens Financials on a quarter, a year, or the default view", () => {
    expect(financialsHref(ACCESS)).toBe(`/portal/${ACCESS}/financials`);
    expect(financialsHref(ACCESS, { grain: "quarter", key: "2026-Q2" })).toBe(
      `/portal/${ACCESS}/financials?period=2026-Q2`,
    );
    expect(financialsHref(ACCESS, { grain: "year", key: "2025" })).toBe(
      `/portal/${ACCESS}/financials?grain=year&period=2025`,
    );
    expect(financialsHref(ACCESS, { grain: "month", key: "2026-05" })).toBe(
      `/portal/${ACCESS}/financials`,
    );
    expect(
      financialsHref(
        ACCESS,
        { grain: "quarter", key: "2026-Q2" },
        "investment",
      ),
    ).toBe(`/portal/${ACCESS}/investment?period=2026-Q2`);
  });

  it("finds the dashboard period of a quarterly or annual report only", () => {
    const r = (type: string, periodStart: string, periodEnd: string) => ({
      type,
      periodStart,
      periodEnd,
    });
    expect(
      dashboardPeriodOfReport(r("QUARTERLY", "2026-04-01", "2026-06-30")),
    ).toEqual({ grain: "quarter", key: "2026-Q2" });
    expect(
      dashboardPeriodOfReport(r("QUARTERLY", "2026-10-01", "2026-12-31")),
    ).toEqual({ grain: "quarter", key: "2026-Q4" });
    expect(
      dashboardPeriodOfReport(r("ANNUAL", "2025-01-01", "2025-12-31")),
    ).toEqual({ grain: "year", key: "2025" });
    // not a calendar quarter / year
    expect(
      dashboardPeriodOfReport(r("QUARTERLY", "2026-02-01", "2026-04-30")),
    ).toBeNull();
    expect(
      dashboardPeriodOfReport(r("QUARTERLY", "2026-04-01", "2026-06-29")),
    ).toBeNull();
    expect(
      dashboardPeriodOfReport(r("ANNUAL", "2025-01-01", "2025-06-30")),
    ).toBeNull();
    // other report types never link to the dashboard
    expect(
      dashboardPeriodOfReport(r("TAX_K1", "2025-01-01", "2025-12-31")),
    ).toBeNull();
    expect(
      dashboardPeriodOfReport({
        type: "QUARTERLY",
        periodStart: null,
        periodEnd: null,
      }),
    ).toBeNull();
  });
});

describe("reportsForPeriod", () => {
  it("a month: the report of its quarter and of its year", () => {
    const rows = reportsForPeriod(
      ACCESS,
      PERIODS,
      { start: "2025-11-01", end: "2025-11-30" },
      REPORTS,
    );
    expect(rows.map((r) => r.key)).toEqual(["2025", "2025-Q4"]);
    expect(rows[1]).toEqual({
      key: "2025-Q4",
      label: "Q4 2025",
      grain: "quarter",
      start: "2025-10-01",
      end: "2025-12-31",
      title: "Q4 2025 report to Members",
      releasedOn: "2026-01-29",
      href: `/portal/${ACCESS}/reports/rep_q4`,
    });
  });

  it("a quarter without a visible report: none of its own, its year's if any", () => {
    expect(
      reportsForPeriod(ACCESS, PERIODS, {
        start: "2026-01-01",
        end: "2026-03-31",
      }),
    ).toEqual([]);
    expect(
      reportsForPeriod(ACCESS, PERIODS, {
        start: "2025-07-01",
        end: "2025-09-30",
      }).map((r) => r.key),
    ).toEqual(["2025", "2025-Q3"]);
  });

  it("a year: itself and its quarters, newest first; title null when not listed", () => {
    const rows = reportsForPeriod(ACCESS, PERIODS, {
      start: "2025-01-01",
      end: "2025-12-31",
    });
    expect(rows.map((r) => r.key)).toEqual(["2025", "2025-Q4", "2025-Q3"]);
    expect(rows.every((r) => r.title === null)).toBe(true);
  });

  it("since inception: every period with a report", () => {
    const rows = reportsForPeriod(ACCESS, PERIODS, {
      start: "2025-07-01",
      end: "2026-06-30",
    });
    expect(rows.map((r) => r.key)).toEqual([
      "2026-Q2",
      "2025",
      "2025-Q4",
      "2025-Q3",
    ]);
  });

  it("nothing published: nothing", () => {
    expect(
      reportsForPeriod(ACCESS, [], { start: "2026-01-01", end: "2026-03-31" }),
    ).toEqual([]);
  });
});

describe("latestPeriodReport", () => {
  it("the report of the latest period that has one", () => {
    expect(latestPeriodReport(ACCESS, PERIODS, REPORTS)?.key).toBe("2026-Q2");
    const withoutQ2 = PERIODS.filter((p) => p.key !== "2026-Q2");
    const r = latestPeriodReport(ACCESS, withoutQ2, REPORTS);
    expect(r?.key).toBe("2025");
    expect(r?.title).toBe("Annual report 2025");
  });

  it("null when no period has a visible report", () => {
    expect(
      latestPeriodReport(
        ACCESS,
        PERIODS.map((p) => ({ ...p, reportId: null })),
      ),
    ).toBeNull();
    expect(latestPeriodReport(ACCESS, [])).toBeNull();
  });
});

function hm(month: string, v: Partial<HolderMonth>): HolderMonth {
  return {
    schemaVersion: 1,
    holderId: "self",
    month,
    asOf: month,
    inProgress: false,
    contributions: 0n,
    credits: 0n,
    forfeited: 0n,
    preferredReturnAccrued: 0n,
    preferredReturnPaid: 0n,
    capitalReturned: 0n,
    residualPaid: 0n,
    grossDistributions: 0n,
    defaultOffsets: 0n,
    taxAdvanceOffsets: 0n,
    netPaid: 0n,
    paidIn: 0n,
    unreturnedCapital: 0n,
    preferredUnits: 0n,
    commonUnits: 0n,
    preferredPct: "0",
    preferredReturnUnpaid: 0n,
    committed: 0n,
    uncalled: 0n,
    calledOutstanding: 0n,
    ...v,
  } as HolderMonth;
}

const MONTHS: HolderMonth[] = [
  hm("2026-01-01", { contributions: 100_000_00n }),
  hm("2026-02-01", { preferredReturnAccrued: 500_00n }),
  hm("2026-03-01", {
    preferredReturnPaid: 1_000_00n,
    capitalReturned: 2_000_00n,
    residualPaid: 300_00n,
    grossDistributions: 3_300_00n,
    taxAdvanceOffsets: 200_00n,
    netPaid: 3_100_00n,
  }),
  hm("2026-04-01", { credits: 5_000_00n }),
  hm("2026-06-01", {
    preferredReturnPaid: 900_00n,
    grossDistributions: 900_00n,
    defaultOffsets: 100_00n,
    netPaid: 800_00n,
  }),
];

describe("distributionRows", () => {
  it("one row per month with a distribution, newest first, with totals and restatement notes", () => {
    const { rows, total } = distributionRows(MONTHS, [
      { month: "2026-03-01", at: "2026-08-01" },
      { month: "2026-03-01", at: "2026-09-15" },
      { month: "2026-05-01", at: "2026-08-01" },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Jun 2026", "Mar 2026"]);
    expect(rows[1]).toEqual({
      month: "2026-03-01",
      label: "Mar 2026",
      preferredReturn: 1_000_00n,
      returnOfCapital: 2_000_00n,
      residual: 300_00n,
      gross: 3_300_00n,
      offsets: 200_00n,
      net: 3_100_00n,
      restatedOn: "2026-09-15",
    });
    expect(rows[0]?.restatedOn).toBeNull();
    expect(total).toEqual({
      preferredReturn: 1_900_00n,
      returnOfCapital: 2_000_00n,
      residual: 300_00n,
      gross: 4_200_00n,
      offsets: 300_00n,
      net: 3_900_00n,
    });
  });

  it("no distribution: no rows, zero totals", () => {
    const { rows, total } = distributionRows([MONTHS[0] as HolderMonth]);
    expect(rows).toEqual([]);
    expect(total.gross).toBe(0n);
  });
});

describe("contributionRows", () => {
  it("one row per month with a contribution or a credit, newest first", () => {
    const { rows, total } = contributionRows(MONTHS);
    expect(rows.map((r) => [r.label, r.contributions, r.credits])).toEqual([
      ["Apr 2026", 0n, 5_000_00n],
      ["Jan 2026", 100_000_00n, 0n],
    ]);
    expect(total).toEqual({ contributions: 100_000_00n, credits: 5_000_00n });
  });
});

describe("newestDocuments", () => {
  it("the n newest shares", () => {
    const d = (name: string, iso: string) => ({
      name,
      sharedAt: new Date(iso),
    });
    const docs = [
      d("a", "2026-01-01T00:00:00Z"),
      d("b", "2026-03-01T00:00:00Z"),
      d("c", "2026-02-01T00:00:00Z"),
      d("e", "2026-04-01T00:00:00Z"),
    ];
    expect(newestDocuments(docs).map((x) => x.name)).toEqual(["e", "b", "c"]);
    expect(newestDocuments(docs, 1).map((x) => x.name)).toEqual(["e"]);
    expect(newestDocuments([])).toEqual([]);
  });
});

describe("reportFinancialsHref", () => {
  const quarterly = {
    type: "QUARTERLY",
    periodStart: "2026-04-01",
    periodEnd: "2026-06-30",
  };
  it("links a quarterly report to its quarter when that quarter is on the dashboard", () => {
    expect(reportFinancialsHref(ACCESS, quarterly, PERIODS)).toBe(
      financialsHref(ACCESS, { grain: "quarter", key: "2026-Q2" }),
    );
  });
  it("links an annual report to its year", () => {
    expect(
      reportFinancialsHref(
        ACCESS,
        { type: "ANNUAL", periodStart: "2025-01-01", periodEnd: "2025-12-31" },
        PERIODS,
      ),
    ).toBe(financialsHref(ACCESS, { grain: "year", key: "2025" }));
  });
  it("has no link when the period has no published figures", () => {
    expect(reportFinancialsHref(ACCESS, quarterly, [])).toBeNull();
    expect(
      reportFinancialsHref(
        ACCESS,
        {
          type: "QUARTERLY",
          periodStart: "2026-07-01",
          periodEnd: "2026-09-30",
        },
        PERIODS,
      ),
    ).toBeNull();
  });
  it("has no link for a notice, a K-1 or an odd range", () => {
    for (const r of [
      { type: "NOTICE", periodStart: null, periodEnd: null },
      { type: "TAX_K1", periodStart: "2025-01-01", periodEnd: "2025-12-31" },
      { type: "QUARTERLY", periodStart: "2026-04-01", periodEnd: "2026-05-31" },
    ]) {
      expect(reportFinancialsHref(ACCESS, r, PERIODS)).toBeNull();
    }
  });
});
