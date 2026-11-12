import { describe, expect, it } from "vitest";
import { buildMemberSchedule } from "./member-schedule";
import {
  COMMON_HEADER,
  csvCell,
  PREFERRED_HEADER,
  toMemberScheduleCsv,
} from "./member-schedule-csv";

const schedule = (prefName: string) =>
  buildMemberSchedule({
    asOf: "2026-11-30",
    today: "2026-11-30",
    companyName: "Octagon GPU I LLC",
    classes: [
      {
        id: "pref",
        kind: "PREFERRED",
        name: "Preferred Units",
        offeringCapCents: 200_000_000,
        finalClosingDate: "2026-11-30",
        initialInstallmentBps: 4000,
        pricePerUnitCents: 100_000,
      },
      {
        id: "common",
        kind: "COMMON",
        name: "Common Units",
        offeringCapCents: null,
        finalClosingDate: null,
        initialInstallmentBps: 4000,
        pricePerUnitCents: null,
      },
    ],
    members: [
      {
        id: "m",
        name: "Octagon Compute LLC",
        memberStatus: "MEMBER",
        isInsider: true,
        admittedOn: "2026-10-01",
        noticeAddress: "1 Main St, Cheyenne, WY 82001",
        noticeEmail: "manager@example.com",
      },
      {
        id: "p",
        name: prefName,
        memberStatus: "MEMBER",
        isInsider: false,
        admittedOn: "2026-11-13",
        noticeAddress: "2 Elm St, Denver, CO 80202",
        noticeEmail: "jane@example.com",
      },
    ],
    positions: [
      {
        stakeholderId: "m",
        unitClassId: "common",
        committedCents: 0,
        pendingCommittedCents: 0,
        capitalCents: 0,
        units: "100.000000",
      },
      {
        stakeholderId: "p",
        unitClassId: "pref",
        committedCents: 25_000_000,
        pendingCommittedCents: 0,
        capitalCents: 10_000_000,
        units: "100.000000",
      },
    ],
    pending: { count: 0, committedCents: 0, overdueDecisions: 0 },
    refunds: { count: 0, outstandingCents: 0 },
  });

describe("toMemberScheduleCsv", () => {
  it("writes the exact header lines, rows and total", () => {
    const lines = toMemberScheduleCsv(schedule("Jane Doe")).split("\r\n");
    expect(lines).toEqual([
      "Common Member,Capital Contribution,Common Units,Common Unit Percentage Interest",
      "Octagon Compute LLC,0.00,100,100.0000%",
      "",
      "Preferred Members,Capital Contribution Committed,Paid to Date,Preferred Units,Preferred Unit Percentage Interest,Date Admitted,Notice Address and Email",
      'Jane Doe,250000.00,100000.00,100,100.0000%,2026-11-13,"2 Elm St, Denver, CO 80202; jane@example.com"',
      "Total,250000.00,100000.00,100,100.0000%,,",
      "",
    ]);
    expect(lines[0]).toBe(COMMON_HEADER);
    expect(lines[3]).toBe(PREFERRED_HEADER);
  });

  it("a member named =cmd is written as '=cmd", () => {
    const csv = toMemberScheduleCsv(schedule("=cmd"));
    expect(csv).toContain("\r\n'=cmd,250000.00,");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@x")).toBe("'@x");
  });

  it("a name with a comma and a quote is quoted and escaped", () => {
    const csv = toMemberScheduleCsv(schedule('Doe, Jane "JD"'));
    expect(csv).toContain('\r\n"Doe, Jane ""JD""",250000.00,');
  });
});
