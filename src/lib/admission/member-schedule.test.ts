import { describe, expect, it } from "vitest";
import {
  buildMemberSchedule,
  largestRemainderPercents,
  type MemberScheduleInput,
} from "./member-schedule";

const member = (
  id: string,
  over: Partial<MemberScheduleInput["members"][number]> = {},
): MemberScheduleInput["members"][number] => ({
  id,
  name: `Member ${id}`,
  memberStatus: "MEMBER",
  isInsider: false,
  admittedOn: "2026-11-13",
  noticeAddress: "1 Main St, Cheyenne, WY 82001",
  noticeEmail: `${id}@example.com`,
  ...over,
});

const pref = (
  stakeholderId: string,
  over: Partial<MemberScheduleInput["positions"][number]> = {},
): MemberScheduleInput["positions"][number] => ({
  stakeholderId,
  unitClassId: "pref",
  committedCents: 0,
  pendingCommittedCents: 0,
  capitalCents: 0,
  units: "0.000000",
  ...over,
});

const input = (
  over: Partial<MemberScheduleInput> = {},
): MemberScheduleInput => ({
  asOf: "2026-11-12",
  today: "2026-11-12",
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
  members: [],
  positions: [],
  pending: { count: 0, committedCents: 0, overdueDecisions: 0 },
  refunds: { count: 0, outstandingCents: 0 },
  ...over,
});

const percentsOf = (units: [string, string][]) => {
  const m = largestRemainderPercents(
    units.map(([stakeholderId, u]) => ({ stakeholderId, units: u })),
  );
  return units.map(([id]) => m.get(id));
};

describe("largestRemainderPercents", () => {
  it("100/100/100 → 33.3334, 33.3333, 33.3333", () => {
    expect(
      percentsOf([
        ["a", "100.000000"],
        ["b", "100.000000"],
        ["c", "100.000000"],
      ]),
    ).toEqual(["33.3334", "33.3333", "33.3333"]);
  });

  it("40/100/60.5 → 19.9501, 49.8753, 30.1746", () => {
    expect(
      percentsOf([
        ["a", "40.000000"],
        ["b", "100.000000"],
        ["c", "60.500000"],
      ]),
    ).toEqual(["19.9501", "49.8753", "30.1746"]);
  });

  it("one member with 250 units → 100.0000; no units → 0.0000", () => {
    expect(percentsOf([["a", "250.000000"]])).toEqual(["100.0000"]);
    expect(percentsOf([["a", "0.000000"]])).toEqual(["0.0000"]);
  });
});

describe("buildMemberSchedule", () => {
  it("Preferred percentages sum to 100.0000 with a total row", () => {
    const s = buildMemberSchedule(
      input({
        members: [member("a"), member("b"), member("c")],
        positions: ["a", "b", "c"].map((id) =>
          pref(id, {
            committedCents: 10_000_000,
            capitalCents: 10_000_000,
            units: "100.000000",
          }),
        ),
      }),
    );
    expect(s.preferred.rows.map((r) => r.percent)).toEqual([
      "33.3334",
      "33.3333",
      "33.3333",
    ]);
    expect(s.preferred.totals).toEqual({
      committedCents: 30_000_000,
      paidCents: 30_000_000,
      units: "300.000000",
      percent: "100.0000",
    });
  });

  it("no units → total percent 0.0000", () => {
    const s = buildMemberSchedule(
      input({
        members: [member("a")],
        positions: [pref("a", { committedCents: 10_000_000 })],
      }),
    );
    expect(s.preferred.rows[0]?.percent).toBe("0.0000");
    expect(s.preferred.totals.percent).toBe("0.0000");
  });

  it("indicators: committed 1,250,000 of cap 2,000,000; days to closing", () => {
    const positions = [pref("a", { committedCents: 125_000_000 })];
    const s = buildMemberSchedule(input({ members: [member("a")], positions }));
    expect(s.indicators.committedCents).toBe(125_000_000);
    expect(s.indicators.remainingCents).toBe(75_000_000);
    expect(s.indicators.capUsedBps).toBe(6250);
    expect(s.indicators.pricePerUnitCents).toBe(100_000);
    expect(s.indicators.daysToFinalClosing).toBe(18);
    const after = buildMemberSchedule(
      input({ members: [member("a")], positions, today: "2026-12-02" }),
    );
    expect(after.indicators.daysToFinalClosing).toBe(-2);
  });

  it("Common: one member with 100 units and capital 0", () => {
    const s = buildMemberSchedule(
      input({
        members: [member("m", { name: "Octagon Compute LLC" })],
        positions: [
          {
            stakeholderId: "m",
            unitClassId: "common",
            committedCents: 0,
            pendingCommittedCents: 0,
            capitalCents: 0,
            units: "100.000000",
          },
        ],
      }),
    );
    expect(s.common.rows).toEqual([
      {
        stakeholderId: "m",
        name: "Octagon Compute LLC",
        capitalContributionCents: 0,
        units: "100.000000",
        percent: "100.0000",
      },
    ]);
    expect(s.common.totalUnits).toBe("100.000000");
    expect(s.managerNotice).toEqual([
      {
        name: "Octagon Compute LLC",
        address: "1 Main St, Cheyenne, WY 82001",
        email: "m@example.com",
      },
    ]);
  });

  it("Paid to Date follows capital including a CREDIT", () => {
    const s = buildMemberSchedule(
      input({
        members: [member("a")],
        positions: [
          pref("a", {
            committedCents: 10_000_000,
            capitalCents: 4_500_000,
            units: "45.000000",
          }),
        ],
      }),
    );
    expect(s.preferred.rows[0]).toMatchObject({
      committedCents: 10_000_000,
      paidCents: 4_500_000,
      units: "45.000000",
    });
  });

  it("drops rows with no commitment and no units (rejected / pending only)", () => {
    const s = buildMemberSchedule(
      input({
        members: [member("a"), member("r"), member("p")],
        positions: [
          pref("a", { committedCents: 1, units: "0.000000" }),
          pref("r"),
          pref("p", { pendingCommittedCents: 10_000_000 }),
        ],
      }),
    );
    expect(s.preferred.rows.map((r) => r.stakeholderId)).toEqual(["a"]);
  });

  it("orders by admittedOn (nulls last), then name, then id", () => {
    const s = buildMemberSchedule(
      input({
        members: [
          member("x", { admittedOn: null, name: "Al" }),
          member("y", { admittedOn: "2026-11-20", name: "Zed" }),
          member("z", { admittedOn: "2026-11-20", name: "Bo" }),
          member("w", { admittedOn: "2026-11-01", name: "Zed" }),
        ],
        positions: ["x", "y", "z", "w"].map((id) =>
          pref(id, { units: "1.000000" }),
        ),
      }),
    );
    expect(s.preferred.rows.map((r) => r.stakeholderId)).toEqual([
      "w",
      "z",
      "y",
      "x",
    ]);
  });

  it("no cap → remaining and capUsedBps null; no closing date → null", () => {
    const s = buildMemberSchedule(
      input({
        classes: [
          {
            id: "pref",
            kind: "PREFERRED",
            name: "Preferred Units",
            offeringCapCents: null,
            finalClosingDate: null,
            initialInstallmentBps: 4000,
            pricePerUnitCents: 100_000,
          },
        ],
      }),
    );
    expect(s.indicators.remainingCents).toBeNull();
    expect(s.indicators.capUsedBps).toBeNull();
    expect(s.indicators.daysToFinalClosing).toBeNull();
  });
});
