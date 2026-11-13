import { describe, expect, it } from "vitest";
import {
  behaviour,
  buildLockedClauses,
  buildRequirements,
  buildStarterBody,
  buildTitle,
  describeRequirements,
  MATTERS,
  PRE_APPROVED_RELATED_PARTY,
  PROTECTED_PROVISIONS,
  paramsSchema,
  RESOLUTION_TYPES,
  type ResolutionType,
} from "./presets";

const CTX = { companyName: "OCTAGON GPU I LLC" };

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

  it("5. PURCHASE_ORDER locked clauses", () => {
    const params = {
      vendor: "Acme Servers Inc.",
      equipment: "8 x GPU server, model X",
      price: "412500.00",
      currency: "USD",
      poReference: "PO-17",
      managerName: "Octagon Compute LLC",
      purchasingAgentName: "Octagon Compute LLC",
    };
    const clauses = buildLockedClauses("PURCHASE_ORDER", params, CTX);
    expect(clauses).toHaveLength(7);
    expect(clauses[1]).toBe(
      "Purchase order. Vendor: Acme Servers Inc. Equipment: 8 x GPU server, model X. Price: USD 412,500.00. Reference: PO-17.",
    );
    const middle = clauses.slice(2, 5).join(" ");
    expect(middle).toContain("solely as agent and nominee");
    expect(middle).toContain("no beneficial interest");
    expect(middle).toContain("in trust for the LLC");
    expect(middle).toContain(
      "assigns to the LLC its rights under the purchase order to the extent assignable",
    );
    expect(clauses[6]).toBe("Approval required: the approval of the Manager.");
    expect(clauses[0]).toContain('Manager of OCTAGON GPU I LLC (the "LLC")');
  });

  it("6. TERM_EXTENSION dates", () => {
    const params = { currentTargetSaleDate: "2031-11-30", extensionNumber: 1 };
    expect(buildTitle("TERM_EXTENSION", params, CTX)).toBe(
      "Extension of the operating term to November 30, 2032",
    );
    const clauses = buildLockedClauses("TERM_EXTENSION", params, CTX);
    expect(clauses[1]).toContain("November 30, 2031");
    expect(clauses[1]).toContain("November 30, 2032");
    expect(
      buildTitle(
        "TERM_EXTENSION",
        { currentTargetSaleDate: "2032-02-29", extensionNumber: 1 },
        CTX,
      ),
    ).toBe("Extension of the operating term to February 28, 2033");
    expect(clauses.at(-1)).toBe(
      "Approval required: the holders of more than 50% of the outstanding Preferred Units. This consent is effective under Section 6.12 when signed by Members holding the required Preferred Units.",
    );
  });

  it("8b. every type returns a non-empty locked-clause list", () => {
    const valid: Record<ResolutionType, unknown> = {
      GENERAL_CONSENT: { matterKey: "OTHER", requireManagerApproval: true },
      RELATED_PARTY: {
        counterparty: "Octagon Compute LLC",
        relationship: "Manager",
        description: "Hosting agreement.",
        amount: "1000.00",
      },
      PURCHASE_ORDER: {
        vendor: "Acme",
        equipment: "Servers",
        price: "30000",
        poReference: "",
        managerName: "Octagon Compute LLC",
        purchasingAgentName: "Octagon Compute LLC",
      },
      TERM_EXTENSION: {
        currentTargetSaleDate: "2031-11-30",
        extensionNumber: 1,
      },
      MANAGER_REMOVAL: { managerName: "Octagon Compute LLC", requestedBy: "" },
      SUCCESSOR_MANAGER: { successorName: "New Co LLC.", reason: "REMOVAL" },
      AMENDMENT: amendment,
      AUDIT_CALL: {
        fiscalYear: 2027,
        scope: "AUDIT",
        periodDescription: "fiscal year 2027",
      },
      MEMBER_LOAN: {
        lenderName: "Jane Doe",
        lenderIsInsider: true,
        principal: "50000.00",
        interestRate: "8% per year",
        maturity: "12 months",
      },
    };
    for (const type of RESOLUTION_TYPES) {
      const clauses = buildLockedClauses(type, valid[type], CTX);
      expect(clauses.length).toBeGreaterThan(0);
      for (const c of clauses) {
        expect(c).not.toBe("");
        expect(c).not.toContain("..");
      }
      expect(clauses.at(-1)).toBe(
        describeRequirements(buildRequirements(type, valid[type])),
      );
      expect(buildTitle(type, valid[type], CTX)).not.toBe("");
      expect(buildStarterBody(type, valid[type], CTX)[0]).toEqual({
        type: "heading",
        text: "Resolved",
      });
    }
    expect(PRE_APPROVED_RELATED_PARTY).toHaveLength(6);
  });

  it("describeRequirements lists affected-member consent once", () => {
    expect(
      describeRequirements(buildRequirements("AMENDMENT", amendment)),
    ).toBe(
      "Approval required: the approval of the Manager; the holders of at least 70% of the outstanding Preferred Units; the holders of at least 70% of the outstanding Disinterested Preferred Units; the approval of the Common Member; the consent of each Member disproportionately and adversely affected. This consent is effective under Section 6.12 when signed by Members holding the required Preferred Units.",
    );
  });
});
