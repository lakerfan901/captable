import { describe, expect, it } from "vitest";
import {
  type AddBusinessDays,
  addMonths,
  annualFinancialsDueOn,
  computeTransferDates,
  firstOfFollowingMonth,
  generateRuleDeadlines,
  k1FinalDueOn,
  k1TargetDueOn,
  quarterlyReportDueOn,
  reminderBucket,
  responseDeadline,
} from "./dates";

const HOLIDAYS = new Set(["2026-11-26", "2026-12-25", "2027-01-01"]);

const fake: AddBusinessDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(iso)) left--;
  }
  return d.toISOString().slice(0, 10);
};

describe("governance dates", () => {
  it("1: Q4 2026 report due date is not rolled", () => {
    expect(quarterlyReportDueOn(2026, 4)).toBe("2027-02-14");
  });

  it("2: 2027 Q1-Q3 report due dates", () => {
    expect(quarterlyReportDueOn(2027, 1)).toBe("2027-05-15");
    expect(quarterlyReportDueOn(2027, 2)).toBe("2027-08-14");
    expect(quarterlyReportDueOn(2027, 3)).toBe("2027-11-14");
  });

  it("3: annual financials FY2026", () => {
    expect(annualFinancialsDueOn(2026)).toBe("2027-03-31");
  });

  it("4: annual financials FY2027 (leap year)", () => {
    expect(annualFinancialsDueOn(2027)).toBe("2028-03-30");
  });

  it("5: K-1 target and final", () => {
    expect(k1TargetDueOn(2026)).toBe("2027-03-31");
    expect(k1FinalDueOn(2026)).toBe("2027-09-15");
  });

  it("6: first of following month", () => {
    expect(firstOfFollowingMonth("2027-01-15")).toBe("2027-02-01");
    expect(firstOfFollowingMonth("2027-01-31")).toBe("2027-02-01");
    expect(firstOfFollowingMonth("2027-02-01")).toBe("2027-03-01");
    expect(firstOfFollowingMonth("2027-12-10")).toBe("2028-01-01");
  });

  it("7: response deadline, end of day in Denver", () => {
    expect(
      responseDeadline(new Date("2031-01-10T21:00:00Z"), 30).toISOString(),
    ).toBe("2031-02-10T06:59:59.999Z");
  });

  it("8: response deadline uses the Denver date of sending", () => {
    expect(
      responseDeadline(new Date("2031-01-11T03:30:00Z"), 30).toISOString(),
    ).toBe("2031-02-10T06:59:59.999Z");
  });

  it("9: response deadline across daylight time start", () => {
    expect(
      responseDeadline(new Date("2027-02-20T18:00:00Z"), 30).toISOString(),
    ).toBe("2027-03-23T05:59:59.999Z");
  });

  it("10: fake business-day adder skips Thanksgiving", () => {
    expect(fake("2026-11-17", 10)).toBe("2026-12-02");
  });

  const voluntary = {
    kind: "VOLUNTARY" as const,
    noticeReceivedOn: "2027-03-01",
    transferNoticeOn: "2027-06-10",
    priceEstablishedOn: null,
  };

  it("11: voluntary transfer dates", () => {
    expect(computeTransferDates(voluntary, fake)).toEqual({
      noticeCopyDueOn: "2027-03-08",
      managerRofrEndsOn: "2027-04-15",
      memberRofrEndsOn: "2027-05-30",
      closeByOn: "2027-11-26",
      purchaseCloseByOn: null,
      effectiveOn: "2027-07-01",
    });
  });

  it("12: involuntary transfer dates", () => {
    expect(
      computeTransferDates(
        {
          ...voluntary,
          kind: "INVOLUNTARY",
          priceEstablishedOn: "2027-06-01",
        },
        fake,
      ),
    ).toEqual({
      noticeCopyDueOn: "2027-03-08",
      managerRofrEndsOn: "2027-04-15",
      memberRofrEndsOn: "2027-05-30",
      closeByOn: null,
      purchaseCloseByOn: "2027-07-16",
      effectiveOn: "2027-07-01",
    });
  });

  it("13: permitted transferee", () => {
    expect(
      computeTransferDates(
        {
          ...voluntary,
          kind: "PERMITTED_TRANSFEREE",
          transferNoticeOn: "2027-03-01",
        },
        fake,
      ),
    ).toEqual({
      noticeCopyDueOn: null,
      managerRofrEndsOn: null,
      memberRofrEndsOn: null,
      closeByOn: null,
      purchaseCloseByOn: null,
      effectiveOn: "2027-04-01",
    });
  });

  it("14: rule deadlines within horizon", () => {
    const specs = generateRuleDeadlines({
      firstAdmittedOn: "2026-11-20",
      today: "2026-11-25",
      horizonDays: 400,
    });
    expect(specs.map((s) => [s.dedupeKey, s.dueOn])).toEqual([
      ["QUARTERLY_REPORT:2026Q4", "2027-02-14"],
      ["ANNUAL_FINANCIALS:2026", "2027-03-31"],
      ["K1_TARGET:2026", "2027-03-31"],
      ["QUARTERLY_REPORT:2027Q1", "2027-05-15"],
      ["QUARTERLY_REPORT:2027Q2", "2027-08-14"],
      ["K1_FINAL:2026", "2027-09-15"],
      ["QUARTERLY_REPORT:2027Q3", "2027-11-14"],
    ]);
    expect(specs[0]).toEqual({
      ruleKey: "QUARTERLY_REPORT",
      dedupeKey: "QUARTERLY_REPORT:2026Q4",
      title: "Q4 2026 quarterly report to Members",
      section: "8.2; 5.6(a)",
      dueOn: "2027-02-14",
    });
    expect(specs[1]?.title).toBe(
      "FY2026 balance sheet and income statement to Members",
    );
    expect(specs[2]?.title).toBe("FY2026 Schedules K-1 to Members (target)");
    expect(specs[5]?.title).toBe(
      "FY2026 Schedules K-1 (extended filing deadline)",
    );
  });

  it("15: no deadlines before first admission", () => {
    expect(
      generateRuleDeadlines({
        firstAdmittedOn: null,
        today: "2026-11-25",
        horizonDays: 400,
      }),
    ).toEqual([]);
  });

  it("16: reminder buckets", () => {
    const todays = [
      "2027-01-10",
      "2027-01-15",
      "2027-01-20",
      "2027-01-31",
      "2027-02-09",
      "2027-02-14",
      "2027-02-15",
      "2027-02-22",
    ];
    expect(todays.map((t) => reminderBucket("2027-02-14", t))).toEqual([
      null,
      30,
      30,
      14,
      7,
      0,
      -1,
      -2,
    ]);
  });

  it("17: addMonths clamps", () => {
    expect(addMonths("2031-11-30", -9)).toBe("2031-02-28");
  });
});
