import { describe, expect, test } from "vitest";
import type { Requirement } from "../llc/voting";
import {
  buildSnapshotEntries,
  decideTransition,
  eligibleRecipients,
  nextReferenceCode,
  type StakeholderRow,
  type UnitPosition,
} from "./resolution-core";

function sh(
  id: string,
  memberStatus: string,
  isInsider = false,
  noticeEmail: string | null = null,
): StakeholderRow {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    noticeEmail,
    memberStatus,
    isInsider,
  };
}

function pos(
  stakeholderId: string,
  units: string,
  opts: { kind?: "PREFERRED" | "COMMON"; suspended?: boolean } = {},
): UnitPosition {
  const kind = opts.kind ?? "PREFERRED";
  return {
    stakeholderId,
    unitClassId: kind === "PREFERRED" ? "uc_pref" : "uc_common",
    unitClassKind: kind,
    units,
    suspended: opts.suspended ?? false,
  };
}

// The G1 register REG, built from stakeholders and positions.
const STAKEHOLDERS: StakeholderRow[] = [
  sh("alice", "MEMBER", false, "alice-notices@example.com"),
  sh("bob", "MEMBER"),
  sh("carol", "MEMBER"),
  sh("dan", "MEMBER"),
  sh("schoen", "MEMBER", true),
  sh("reidTrust", "MEMBER", true),
  sh("sam", "MEMBER"),
  sh("fay", "FINANCIAL_INTEREST_ONLY"),
  sh("octagon", "MEMBER", true),
  sh("pete", "PROSPECT"),
];

const POSITIONS: UnitPosition[] = [
  pos("alice", "400.000000"),
  pos("bob", "300.000000"),
  pos("carol", "150.000000"),
  pos("dan", "50.000000"),
  pos("dan", "0.500000"),
  pos("schoen", "100.000000"),
  pos("reidTrust", "49.500000"),
  pos("sam", "200.000000", { suspended: true }),
  pos("fay", "75.000000"),
  pos("octagon", "100.000000", { kind: "COMMON" }),
];

const built = buildSnapshotEntries(STAKEHOLDERS, POSITIONS);
const ENTRIES = built.entries;

const ids = (rows: { stakeholderId: string }[]) =>
  rows.map((r) => r.stakeholderId);

describe("resolution-core", () => {
  test("1: snapshot totals from stakeholders + positions", () => {
    expect(built.preferredIssued).toBe("1325.000000");
    expect(built.preferredOutstanding).toBe("1050.000000");
    expect(built.disinterestedOutstanding).toBe("900.500000");
    // The PROSPECT without units is omitted.
    expect(ids(ENTRIES)).not.toContain("pete");
    expect(ENTRIES).toHaveLength(9);

    const by = new Map(ENTRIES.map((e) => [e.stakeholderId, e]));
    expect(by.get("dan")?.preferredUnits).toBe("50.500000");
    expect(by.get("sam")?.isSuspended).toBe(true);
    expect(by.get("alice")?.isSuspended).toBe(false);
    expect(by.get("fay")?.isMember).toBe(false);
    expect(by.get("fay")?.memberStatus).toBe("FINANCIAL_INTEREST_ONLY");
    expect(by.get("octagon")).toMatchObject({
      preferredUnits: "0.000000",
      commonUnits: "100.000000",
      isInsider: true,
      isMember: true,
    });
    // noticeEmail wins over email.
    expect(by.get("alice")?.email).toBe("alice-notices@example.com");
    expect(by.get("bob")?.email).toBe("bob@example.com");
  });

  test("1a: a PROSPECT holding units is kept; unknown holder throws", () => {
    const withUnits = buildSnapshotEntries(
      [sh("pete", "PROSPECT")],
      [pos("pete", "1.000000")],
    );
    expect(withUnits.entries).toHaveLength(1);
    expect(withUnits.entries[0]?.isMember).toBe(false);
    expect(withUnits.preferredIssued).toBe("1.000000");
    expect(withUnits.preferredOutstanding).toBe("0.000000");

    expect(() =>
      buildSnapshotEntries([sh("a", "MEMBER")], [pos("ghost", "1.000000")]),
    ).toThrow();
  });

  test("1b: a suspended COMMON position does not suspend the holder", () => {
    const r = buildSnapshotEntries(
      [sh("x", "MEMBER")],
      [
        pos("x", "10.000000"),
        pos("x", "5.000000", { kind: "COMMON", suspended: true }),
      ],
    );
    expect(r.entries[0]?.isSuspended).toBe(false);
    expect(r.preferredOutstanding).toBe("10.000000");
  });

  test("2: eligible recipients", () => {
    const dis: Requirement[] = [
      { kind: "UNIT_VOTE", basis: "DISINTERESTED_MAJORITY" },
    ];
    expect(ids(eligibleRecipients(ENTRIES, dis))).toEqual([
      "alice",
      "bob",
      "carol",
      "dan",
    ]);
    for (const r of eligibleRecipients(ENTRIES, dis)) {
      expect(r).toMatchObject({
        countsPreferred: false,
        countsDisinterested: true,
        consentOnly: false,
      });
    }

    const both: Requirement[] = [
      { kind: "UNIT_VOTE", basis: "PREFERRED_SUPERMAJORITY" },
      { kind: "UNIT_VOTE", basis: "DISINTERESTED_70" },
    ];
    const six = eligibleRecipients(ENTRIES, both);
    expect(ids(six)).toEqual([
      "alice",
      "bob",
      "carol",
      "dan",
      "reidTrust",
      "schoen",
    ]);
    const byId = new Map(six.map((r) => [r.stakeholderId, r]));
    expect(byId.get("schoen")).toMatchObject({
      countsPreferred: true,
      countsDisinterested: false,
      consentOnly: false,
    });
    expect(byId.get("reidTrust")?.countsDisinterested).toBe(false);
    expect(byId.get("alice")).toMatchObject({
      countsPreferred: true,
      countsDisinterested: true,
    });

    const withConsent: Requirement[] = [
      ...both,
      { kind: "AFFECTED_MEMBER_CONSENT", stakeholderId: "sam" },
    ];
    const seven = eligibleRecipients(ENTRIES, withConsent);
    expect(ids(seven)).toEqual([
      "alice",
      "bob",
      "carol",
      "dan",
      "reidTrust",
      "sam",
      "schoen",
    ]);
    expect(seven.find((r) => r.stakeholderId === "sam")).toEqual({
      stakeholderId: "sam",
      countsPreferred: false,
      countsDisinterested: false,
      consentOnly: true,
    });
  });

  test("2a: a named eligible Member is not consent-only", () => {
    const r = eligibleRecipients(ENTRIES, [
      { kind: "UNIT_VOTE", basis: "PREFERRED_MAJORITY" },
      { kind: "AFFECTED_MEMBER_CONSENT", stakeholderId: "alice" },
    ]);
    expect(r.find((x) => x.stakeholderId === "alice")?.consentOnly).toBe(false);
    // Manager-only requirements produce no recipients.
    expect(eligibleRecipients(ENTRIES, [{ kind: "MANAGER_APPROVAL" }])).toEqual(
      [],
    );
  });

  test("3: decideTransition", () => {
    const closesAt = new Date("2027-01-31T06:59:59.999Z");
    const before = new Date("2027-01-31T06:59:59.999Z");
    const after = new Date("2027-01-31T07:00:00.000Z");
    const base = {
      status: "SENT",
      closesAt,
      now: before,
      deemedAgainstAtClose: false,
    };
    expect(decideTransition({ ...base, outcome: "PASSED" })).toBe("EFFECTIVE");
    expect(decideTransition({ ...base, outcome: "CANNOT_PASS" })).toBe(
      "FAILED",
    );
    expect(decideTransition({ ...base, outcome: "PENDING" })).toBeNull();
    expect(decideTransition({ ...base, now: after, outcome: "PENDING" })).toBe(
      "EXPIRED",
    );
    expect(
      decideTransition({
        ...base,
        now: after,
        outcome: "PENDING",
        deemedAgainstAtClose: true,
      }),
    ).toBe("FAILED");
    expect(
      decideTransition({
        ...base,
        closesAt: null,
        now: after,
        outcome: "PENDING",
      }),
    ).toBeNull();
    for (const status of ["DRAFT", "EFFECTIVE", "FAILED", "WITHDRAWN"]) {
      expect(decideTransition({ ...base, status, outcome: "PASSED" })).toBe(
        null,
      );
      expect(
        decideTransition({ ...base, status, now: after, outcome: "PENDING" }),
      ).toBeNull();
    }
  });

  test("4: nextReferenceCode", () => {
    expect(
      nextReferenceCode(["R-2026-001", "R-2026-009", "R-2025-030"], 2026),
    ).toBe("R-2026-010");
    expect(nextReferenceCode([], 2027)).toBe("R-2027-001");
    expect(nextReferenceCode(["R-2026-999"], 2026)).toBe("R-2026-1000");
    expect(nextReferenceCode(["X-2026-005", "R-2026-00"], 2026)).toBe(
      "R-2026-001",
    );
  });
});
