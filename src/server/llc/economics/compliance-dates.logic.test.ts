import { describe, expect, it } from "vitest";
import { OA_DEFAULTS } from "../../../lib/llc/config";
import { creditDate, forfeitureDate } from "../../../lib/llc/default";
import { computeTermClock } from "../../../lib/llc/term";
import {
  buildComplianceDates,
  type ComplianceInput,
  complianceQuarterEnds,
  nextComplianceDates,
} from "./compliance-dates.logic";

const clock = computeTermClock(
  {
    operationsCommencementDate: "2027-02-15",
    extensionsApproved: 0,
    loiExtensionDays: 0,
  },
  OA_DEFAULTS,
);

function input(over: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    today: "2027-04-01",
    range: { from: "2027-01-01", to: "2027-12-31" },
    config: OA_DEFAULTS,
    clock,
    firstReceiptOn: "2026-11-16",
    quarters: [],
    callLines: [],
    anyUncalledBalance: false,
    defaults: [],
    loans: [],
    ocdNoticeSentOn: null,
    ...over,
  };
}

const ofKind = (list: ReturnType<typeof buildComplianceDates>, kind: string) =>
  list.filter((d) => d.kind === kind).map((d) => [d.dueOn, d.status]);

describe("buildComplianceDates", () => {
  it("distribution deadlines without Available Cash", () => {
    const out = buildComplianceDates(input());
    expect(ofKind(out, "DISTRIBUTION_DEADLINE")).toEqual([
      ["2027-02-14", "NOT_REQUIRED"],
      ["2027-05-15", "NOT_REQUIRED"],
      ["2027-08-14", "OPEN"],
      ["2027-11-14", "OPEN"],
    ]);
    expect(ofKind(out, "QUARTERLY_REPORT_DEADLINE")).toEqual([
      ["2027-02-14", "OPEN"],
      ["2027-05-15", "OPEN"],
      ["2027-08-14", "OPEN"],
      ["2027-11-14", "OPEN"],
    ]);
    expect(out.find((d) => d.kind === "DISTRIBUTION_DEADLINE")?.key).toBe(
      "DISTRIBUTION_DEADLINE:2026-12-31",
    );
  });

  it("Q1 2027 with Available Cash of $12,000.00 and no distribution", () => {
    const q1 = {
      quarterEnd: "2027-03-31",
      hasDistribution: false,
      availableCash: 1_200_000n,
    };
    const quarters = [q1];
    const open = buildComplianceDates(input({ quarters }));
    expect(
      ofKind(open, "DISTRIBUTION_DEADLINE").find((x) => x[0] === "2027-05-15"),
    ).toEqual(["2027-05-15", "OPEN"]);
    const late = buildComplianceDates(input({ quarters, today: "2027-05-16" }));
    expect(
      ofKind(late, "DISTRIBUTION_DEADLINE").find((x) => x[0] === "2027-05-15"),
    ).toEqual(["2027-05-15", "OVERDUE"]);
    const done = buildComplianceDates(
      input({
        quarters: [{ ...q1, hasDistribution: true }],
        today: "2027-05-16",
      }),
    );
    expect(
      ofKind(done, "DISTRIBUTION_DEADLINE").find((x) => x[0] === "2027-05-15"),
    ).toEqual(["2027-05-15", "DONE"]);
  });

  it("term clock dates", () => {
    const out = buildComplianceDates(
      input({ range: { from: "2027-01-01", to: "2033-12-31" } }),
    );
    expect(ofKind(out, "OCD_NOTICE_DUE")).toEqual([["2027-03-01", "OVERDUE"]]);
    expect(ofKind(out, "EXTENSION_REQUEST_DUE")).toEqual([
      ["2031-05-15", "OPEN"],
    ]);
    expect(ofKind(out, "TARGET_SALE_DATE")).toEqual([["2032-02-15", "OPEN"]]);
    expect(ofKind(out, "DISSOLUTION_ELECTION_AVAILABLE")).toEqual([
      ["2032-08-13", "INFO"],
    ]);
    const sent = buildComplianceDates(input({ ocdNoticeSentOn: "2027-02-20" }));
    expect(ofKind(sent, "OCD_NOTICE_DUE")).toEqual([]);
  });

  it("E11 worked case: Forfeiture Date then Credit Date", () => {
    const fd = forfeitureDate("2027-01-20", OA_DEFAULTS);
    const cd = creditDate(
      { dueOn: "2027-01-20", forfeitureDate: fd, fullyFundedOn: null },
      OA_DEFAULTS,
    );
    expect([fd, cd]).toEqual(["2027-01-27", "2027-02-19"]);
    const base = {
      id: "d1",
      status: "OPEN" as const,
      forfeitureDate: fd,
      creditDate: cd,
      creditConfirmed: false,
      outstanding: 6_000_000n,
    };
    const before = buildComplianceDates(
      input({
        today: "2027-01-25",
        defaults: [{ ...base, forfeitureConfirmed: false }],
      }),
    );
    expect(ofKind(before, "FORFEITURE_DATE")).toEqual([["2027-01-27", "OPEN"]]);
    expect(ofKind(before, "CREDIT_DATE")).toEqual([]);
    expect(ofKind(before, "REPLACEMENT_FUNDER_OUTSIDE_DATE")).toEqual([
      ["2027-06-30", "OPEN"],
    ]);
    const due = buildComplianceDates(
      input({
        today: "2027-01-28",
        defaults: [{ ...base, forfeitureConfirmed: false }],
      }),
    );
    expect(ofKind(due, "FORFEITURE_DATE")).toEqual([
      ["2027-01-27", "ACTION_REQUIRED"],
    ]);
    const after = buildComplianceDates(
      input({
        today: "2027-02-01",
        defaults: [{ ...base, forfeitureConfirmed: true }],
      }),
    );
    expect(ofKind(after, "FORFEITURE_DATE")).toEqual([]);
    expect(ofKind(after, "CREDIT_DATE")).toEqual([["2027-02-19", "OPEN"]]);
    const credit = buildComplianceDates(
      input({
        today: "2027-02-19",
        defaults: [{ ...base, forfeitureConfirmed: true }],
      }),
    );
    expect(ofKind(credit, "CREDIT_DATE")).toEqual([
      ["2027-02-19", "ACTION_REQUIRED"],
    ]);
    const voided = buildComplianceDates(
      input({
        defaults: [{ ...base, status: "VOIDED", forfeitureConfirmed: false }],
      }),
    );
    expect(ofKind(voided, "FORFEITURE_DATE")).toEqual([]);
    expect(ofKind(voided, "REPLACEMENT_FUNDER_OUTSIDE_DATE")).toEqual([]);
  });

  it("call lines, outside date and loans", () => {
    const out = buildComplianceDates(
      input({
        today: "2027-01-25",
        callLines: [
          { id: "l1", dueOn: "2027-01-20", outstanding: 100n },
          { id: "l2", dueOn: "2027-01-28", outstanding: 100n },
          { id: "l3", dueOn: "2027-01-28", outstanding: 0n },
        ],
        anyUncalledBalance: true,
        loans: [
          { id: "m1", maturityOn: "2027-06-01", principalOutstanding: 500n },
          { id: "m2", maturityOn: "2027-06-01", principalOutstanding: 0n },
        ],
      }),
    );
    expect(ofKind(out, "CALL_NOTICE_DUE")).toEqual([
      ["2027-01-20", "OVERDUE"],
      ["2027-01-28", "OPEN"],
    ]);
    expect(ofKind(out, "BALANCE_OUTSIDE_DATE")).toEqual([
      ["2027-03-31", "OPEN"],
    ]);
    expect(ofKind(out, "MEMBER_LOAN_MATURITY")).toEqual([
      ["2027-06-01", "OPEN"],
    ]);
    expect(out.find((d) => d.sourceId === "l1")?.key).toBe(
      "CALL_NOTICE_DUE:l1",
    );
  });

  it("no receipt, no quarters; range bounds", () => {
    expect(complianceQuarterEnds(null, input().range, OA_DEFAULTS)).toEqual([]);
    expect(
      complianceQuarterEnds(
        "2026-11-16",
        { from: "2027-02-15", to: "2027-05-15" },
        OA_DEFAULTS,
      ).map((q) => q.deadline),
    ).toEqual(["2027-05-15"]);
  });
});

describe("nextComplianceDates", () => {
  it("skips done, not required and past reminders", () => {
    const out = buildComplianceDates(input());
    const next = nextComplianceDates(out, "2027-04-01", 5);
    expect(next.map((d) => [d.kind, d.dueOn])).toEqual([
      ["OCD_NOTICE_DUE", "2027-03-01"],
      ["QUARTERLY_REPORT_DEADLINE", "2027-05-15"],
      ["DISTRIBUTION_DEADLINE", "2027-08-14"],
      ["QUARTERLY_REPORT_DEADLINE", "2027-08-14"],
      ["DISTRIBUTION_DEADLINE", "2027-11-14"],
    ]);
  });
});
