import { describe, expect, test } from "vitest";
import {
  type ApprovalState,
  applyDeemedAgainst,
  type CastVote,
  type Choice,
  denominator,
  evaluate,
  fromMicro,
  type HolderSnapshot,
  MANAGER_ONLY,
  minimumFor,
  type Requirement,
  tallyBasis,
  toMicro,
  type VoteBasis,
} from "./voting";

function h(
  stakeholderId: string,
  preferredUnits: string,
  isMember: boolean,
  isSuspended: boolean,
  isInsider: boolean,
): HolderSnapshot {
  return { stakeholderId, preferredUnits, isMember, isSuspended, isInsider };
}

const REG: HolderSnapshot[] = [
  h("alice", "400.000000", true, false, false),
  h("bob", "300.000000", true, false, false),
  h("carol", "150.000000", true, false, false),
  h("dan", "50.500000", true, false, false),
  h("schoen", "100.000000", true, false, true),
  h("reidTrust", "49.500000", true, false, true),
  h("sam", "200.000000", true, true, false),
  h("fay", "75.000000", false, false, false),
  h("octagon", "0.000000", true, false, true),
];

const vote = (choice: Choice, ...ids: string[]): CastVote[] =>
  ids.map((stakeholderId) => ({ stakeholderId, choice }));
const forVotes = (...ids: string[]) => vote("FOR", ...ids);

/** Two-holder register x / y, both disinterested Members in good standing. */
const pair = (x: string, y: string): HolderSnapshot[] => [
  h("x", x, true, false, false),
  h("y", y, true, false, false),
];

const unitVote = (basis: VoteBasis): Requirement => ({
  kind: "UNIT_VOTE",
  basis,
});
const approved: ApprovalState = {
  managerApproved: true,
  commonMemberApproved: false,
};
const notApproved: ApprovalState = {
  managerApproved: false,
  commonMemberApproved: false,
};

describe("voting", () => {
  test("1: toMicro / fromMicro", () => {
    expect(toMicro("50.5")).toBe(50500000n);
    expect(toMicro("0.000001")).toBe(1n);
    expect(fromMicro(525000001n)).toBe("525.000001");
  });

  test("2: toMicro rejects invalid input", () => {
    for (const bad of ["1.0000001", "-1", "1e3", ""]) {
      expect(() => toMicro(bad)).toThrow(RangeError);
    }
  });

  test("3: denominators", () => {
    expect(denominator(REG, "PREFERRED_MAJORITY")).toBe(1050000000n);
    expect(denominator(REG, "DISINTERESTED_67")).toBe(900500000n);
  });

  test("4: minimumFor preferred bases", () => {
    expect(minimumFor(1050000000n, "PREFERRED_MAJORITY")).toBe(525000001n);
    expect(minimumFor(1050000000n, "PREFERRED_SUPERMAJORITY")).toBe(735000000n);
  });

  test("5: minimumFor disinterested bases", () => {
    expect(minimumFor(900500000n, "DISINTERESTED_MAJORITY")).toBe(450250001n);
    expect(minimumFor(900500000n, "DISINTERESTED_67")).toBe(603335000n);
    expect(minimumFor(900500000n, "DISINTERESTED_70")).toBe(630350000n);
  });

  test("6: majority, alice + schoen", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "schoen"),
      "PREFERRED_MAJORITY",
    );
    expect(t.for).toBe("500.000000");
    expect(t.passed).toBe(false);
    expect(t.cannotPass).toBe(false);
    expect(t.forBps).toBe(4761);
  });

  test("7: majority, alice + carol", () => {
    const t = tallyBasis(REG, forVotes("alice", "carol"), "PREFERRED_MAJORITY");
    expect(t.for).toBe("550.000000");
    expect(t.passed).toBe(true);
  });

  test("8: majority, insiders count", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "schoen", "reidTrust"),
      "PREFERRED_MAJORITY",
    );
    expect(t.for).toBe("549.500000");
    expect(t.passed).toBe(true);
  });

  test("9: majority, suspended and non-Member ignored", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "sam", "fay"),
      "PREFERRED_MAJORITY",
    );
    expect(t.for).toBe("400.000000");
    expect(t.passed).toBe(false);
    expect(t.eligibleCount).toBe(6);
  });

  test("10: boundary, exactly 50% fails", () => {
    const t = tallyBasis(
      pair("500", "500"),
      forVotes("x"),
      "PREFERRED_MAJORITY",
    );
    expect(t.passed).toBe(false);
    expect(t.minimumFor).toBe("500.000001");
  });

  test("11: boundary, just over 50% passes", () => {
    const t = tallyBasis(
      pair("500.000001", "499.999999"),
      forVotes("x"),
      "PREFERRED_MAJORITY",
    );
    expect(t.passed).toBe(true);
  });

  test("12: supermajority, alice + bob", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "bob"),
      "PREFERRED_SUPERMAJORITY",
    );
    expect(t.for).toBe("700.000000");
    expect(t.passed).toBe(false);
    expect(t.forBps).toBe(6666);
  });

  test("13: supermajority, alice + bob + dan", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "bob", "dan"),
      "PREFERRED_SUPERMAJORITY",
    );
    expect(t.for).toBe("750.500000");
    expect(t.passed).toBe(true);
  });

  test("14: boundary, exactly 70% passes", () => {
    const t = tallyBasis(
      pair("700", "300"),
      forVotes("x"),
      "PREFERRED_SUPERMAJORITY",
    );
    expect(t.passed).toBe(true);
  });

  test("15: boundary, just under 70% fails", () => {
    const t = tallyBasis(
      pair("699.999999", "300.000001"),
      forVotes("x"),
      "PREFERRED_SUPERMAJORITY",
    );
    expect(t.passed).toBe(false);
  });

  test("16: disinterested majority, alice", () => {
    const t = tallyBasis(REG, forVotes("alice"), "DISINTERESTED_MAJORITY");
    expect(t.for).toBe("400.000000");
    expect(t.passed).toBe(false);
  });

  test("17: disinterested majority, alice + dan", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "dan"),
      "DISINTERESTED_MAJORITY",
    );
    expect(t.for).toBe("450.500000");
    expect(t.passed).toBe(true);
  });

  test("18: disinterested majority, insider votes ignored", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "schoen", "reidTrust"),
      "DISINTERESTED_MAJORITY",
    );
    expect(t.for).toBe("400.000000");
    expect(t.passed).toBe(false);
  });

  test("19: boundary, disinterested exactly 50% fails", () => {
    const t = tallyBasis(
      pair("450.25", "450.25"),
      forVotes("x"),
      "DISINTERESTED_MAJORITY",
    );
    expect(t.passed).toBe(false);
  });

  test("20: disinterested 67, alice + bob", () => {
    const t = tallyBasis(REG, forVotes("alice", "bob"), "DISINTERESTED_67");
    expect(t.for).toBe("700.000000");
    expect(t.passed).toBe(true);
  });

  test("21: disinterested 67, alice + carol + dan", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "carol", "dan"),
      "DISINTERESTED_67",
    );
    expect(t.for).toBe("600.500000");
    expect(t.passed).toBe(false);
    expect(t.minimumFor).toBe("603.335000");
  });

  test("22: boundary, exactly 67% passes", () => {
    const t = tallyBasis(pair("67", "33"), forVotes("x"), "DISINTERESTED_67");
    expect(t.passed).toBe(true);
  });

  test("23: two-thirds is not enough", () => {
    const t = tallyBasis(pair("200", "100"), forVotes("x"), "DISINTERESTED_67");
    expect(t.passed).toBe(false);
    expect(t.minimumFor).toBe("201.000000");
  });

  test("24: disinterested 70, alice + bob", () => {
    const t = tallyBasis(REG, forVotes("alice", "bob"), "DISINTERESTED_70");
    expect(t.passed).toBe(true);
  });

  test("25: disinterested 70, alice + carol + dan", () => {
    const t = tallyBasis(
      REG,
      forVotes("alice", "carol", "dan"),
      "DISINTERESTED_70",
    );
    expect(t.for).toBe("600.500000");
    expect(t.passed).toBe(false);
  });

  test("26: boundary, disinterested exactly 70% passes", () => {
    const t = tallyBasis(
      pair("630.35", "270.15"),
      forVotes("x"),
      "DISINTERESTED_70",
    );
    expect(t.passed).toBe(true);
  });

  test("27: cannotPass with against and abstain", () => {
    const t = tallyBasis(
      REG,
      [...vote("AGAINST", "bob"), ...vote("ABSTAIN", "carol")],
      "PREFERRED_SUPERMAJORITY",
    );
    expect(t.for).toBe("0.000000");
    expect(t.against).toBe("300.000000");
    expect(t.abstain).toBe("150.000000");
    expect(t.notVoted).toBe("600.000000");
    expect(t.cannotPass).toBe(true);
  });

  test("28: one against still can pass", () => {
    const t = tallyBasis(
      REG,
      vote("AGAINST", "bob"),
      "PREFERRED_SUPERMAJORITY",
    );
    expect(t.notVoted).toBe("750.000000");
    expect(t.cannotPass).toBe(false);
  });

  const protectedAmendment: Requirement[] = [
    { kind: "MANAGER_APPROVAL" },
    unitVote("PREFERRED_SUPERMAJORITY"),
    unitVote("DISINTERESTED_70"),
  ];

  test("29: protected amendment passes", () => {
    const e = evaluate(
      protectedAmendment,
      REG,
      forVotes("alice", "bob", "schoen"),
      approved,
    );
    expect(e.outcome).toBe("PASSED");
    expect(e.results[1]?.tally?.for).toBe("800.000000");
    expect(e.results[2]?.tally?.for).toBe("700.000000");
  });

  test("30: protected amendment pending without manager approval", () => {
    const e = evaluate(
      protectedAmendment,
      REG,
      forVotes("alice", "bob", "schoen"),
      notApproved,
    );
    expect(e.outcome).toBe("PENDING");
    expect(e.results[0]?.state).toBe("PENDING");
  });

  const votes31 = forVotes("alice", "carol", "dan", "schoen", "reidTrust");

  test("31: supermajority passed, disinterested 70 pending", () => {
    const e = evaluate(protectedAmendment, REG, votes31, approved);
    expect(e.results[1]?.state).toBe("PASSED");
    expect(e.results[1]?.tally?.for).toBe("750.000000");
    expect(e.results[2]?.state).toBe("PENDING");
    expect(e.results[2]?.tally?.for).toBe("600.500000");
    expect(e.outcome).toBe("PENDING");
  });

  test("32: insiders cannot carry a protected amendment", () => {
    const e = evaluate(
      protectedAmendment,
      REG,
      [...votes31, ...vote("AGAINST", "bob")],
      approved,
    );
    expect(e.results[2]?.state).toBe("CANNOT_PASS");
    expect(e.outcome).toBe("CANNOT_PASS");
  });

  test("33: insider loan needs supermajority and disinterested majority", () => {
    const e = evaluate(
      [unitVote("PREFERRED_SUPERMAJORITY"), unitVote("DISINTERESTED_MAJORITY")],
      REG,
      forVotes("alice", "bob", "dan"),
      notApproved,
    );
    expect(e.outcome).toBe("PASSED");
  });

  test("34: affected member consent ignores suspension", () => {
    const reqs: Requirement[] = [
      { kind: "AFFECTED_MEMBER_CONSENT", stakeholderId: "sam" },
    ];
    expect(
      evaluate(reqs, REG, forVotes("sam"), notApproved).results[0]?.state,
    ).toBe("PASSED");
    expect(
      evaluate(reqs, REG, vote("ABSTAIN", "sam"), notApproved).results[0]
        ?.state,
    ).toBe("CANNOT_PASS");
    expect(evaluate(reqs, REG, [], notApproved).results[0]?.state).toBe(
      "PENDING",
    );
  });

  test("35: manager-only resolution", () => {
    const e = evaluate(MANAGER_ONLY, REG, [], approved);
    expect(e.outcome).toBe("PASSED");
  });

  test("36: deemed against for non-responders", () => {
    const r = applyDeemedAgainst(REG, forVotes("alice"), [
      "PREFERRED_MAJORITY",
    ]);
    expect(r.deemedStakeholderIds).toEqual([
      "bob",
      "carol",
      "dan",
      "schoen",
      "reidTrust",
    ]);
    expect(r.votes).toHaveLength(6);
  });

  test("37: all insiders, disinterested basis", () => {
    const insiders = [
      h("i1", "100", true, false, true),
      h("i2", "50", true, false, true),
    ];
    const t = tallyBasis(insiders, forVotes("i1"), "DISINTERESTED_MAJORITY");
    expect(t.denominator).toBe("0.000000");
    expect(t.minimumFor).toBeNull();
    expect(t.passed).toBe(false);
    expect(t.cannotPass).toBe(true);
  });

  test("38: duplicate vote throws", () => {
    expect(() =>
      tallyBasis(REG, forVotes("alice", "alice"), "PREFERRED_MAJORITY"),
    ).toThrow("duplicate vote");
  });
});
