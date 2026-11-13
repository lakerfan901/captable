import { describe, expect, it } from "vitest";
import {
  behaviour,
  buildRequirements,
  MATTERS,
  PROTECTED_PROVISIONS,
  paramsSchema,
} from "./presets";

const SUPER = { kind: "UNIT_VOTE", basis: "PREFERRED_SUPERMAJORITY" };
const DIS_MAJ = { kind: "UNIT_VOTE", basis: "DISINTERESTED_MAJORITY" };
const MANAGER = { kind: "MANAGER_APPROVAL" };

const amendment = {
  summary: "Change Section 5.6",
  touchesProtectedProvision: true,
  protectedSections: ["Section 5.6"],
  adverseToCommon: true,
  affectedMemberIds: ["s1", "s2"],
};

describe("presets", () => {
  it("1. AMENDMENT builds six requirements in order", () => {
    const specs = buildRequirements("AMENDMENT", amendment);
    expect(specs.map((s) => s.requirement)).toEqual([
      MANAGER,
      SUPER,
      { kind: "UNIT_VOTE", basis: "DISINTERESTED_70" },
      { kind: "COMMON_MEMBER_APPROVAL" },
      { kind: "AFFECTED_MEMBER_CONSENT", stakeholderId: "s1" },
      { kind: "AFFECTED_MEMBER_CONSENT", stakeholderId: "s2" },
    ]);
    expect(specs.map((s) => s.section)).toEqual([
      "12.1",
      "12.1",
      "12.1(c)",
      "12.1(d)",
      "12.1(b)",
      "12.1(b)",
    ]);
  });

  it("2. AMENDMENT protected flag must match the section list", () => {
    const schema = paramsSchema("AMENDMENT");
    expect(
      schema.safeParse({ ...amendment, protectedSections: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...amendment, touchesProtectedProvision: false })
        .success,
    ).toBe(false);
    expect(schema.safeParse(amendment).success).toBe(true);
    expect(PROTECTED_PROVISIONS).toHaveLength(20);
  });

  it("3. MEMBER_LOAN adds a disinterested vote for insiders", () => {
    const base = {
      lenderName: "Jane Doe",
      principal: "50000.00",
      interestRate: "8% per year",
      maturity: "12 months",
    };
    expect(
      buildRequirements("MEMBER_LOAN", { ...base, lenderIsInsider: true }).map(
        (s) => s.requirement,
      ),
    ).toEqual([SUPER, DIS_MAJ]);
    expect(
      buildRequirements("MEMBER_LOAN", { ...base, lenderIsInsider: false }).map(
        (s) => s.requirement,
      ),
    ).toEqual([SUPER]);
  });

  it("4. GENERAL_CONSENT uses the matter catalogue and only adds", () => {
    const req = (p: object) =>
      buildRequirements("GENERAL_CONSENT", {
        requireManagerApproval: false,
        ...p,
      }).map((s) => s.requirement);
    expect(req({ matterKey: "EARLY_DISSOLUTION" })).toEqual([MANAGER, SUPER]);
    expect(req({ matterKey: "POST_TARGET_DISSOLUTION" })).toEqual([SUPER]);
    expect(
      req({ matterKey: "OTHER", additionalBases: ["DISINTERESTED_MAJORITY"] }),
    ).toEqual([SUPER, DIS_MAJ]);
    expect(() => req({ matterKey: "TERM_EXTENSION" })).toThrow();
  });

  it("7. behaviour", () => {
    expect(behaviour("TERM_EXTENSION")).toMatchObject({
      hasBallots: true,
      fixedWindowDays: 30,
      deemedAgainstAtClose: true,
      allRecipientsRequired: true,
      copyToMembersBusinessDays: null,
      alsoFileUnder: null,
      kindLabel: "Action by Written Consent of the Members",
    });
    expect(behaviour("PURCHASE_ORDER").hasBallots).toBe(false);
    expect(behaviour("PURCHASE_ORDER").copyToMembersBusinessDays).toBe(10);
    expect(behaviour("AMENDMENT").alsoFileUnder).toBe("ARTICLES_AND_AGREEMENT");
  });

  it("8. every matter has requirements and a section", () => {
    const keys = Object.keys(MATTERS);
    expect(keys).toHaveLength(26);
    for (const key of keys) {
      const m = MATTERS[key];
      expect(m?.requirements.length).toBeGreaterThan(0);
      expect(m?.section).not.toBe("");
    }
  });
});
