// Resolution presets and matter catalogue (03-governance.md G5). Pure: no
// database, no `@/` imports. The server never trusts requirements sent by the
// browser; it always rebuilds them with `buildRequirements`.
//
// Session a: types, parameter schemas, MATTERS, PROTECTED_PROVISIONS,
// buildRequirements, behaviour. Session b adds buildTitle, buildStarterBody,
// buildLockedClauses, describeRequirements and PRE_APPROVED_RELATED_PARTY.

import { z } from "zod";
import type { Requirement, VoteBasis } from "../llc/voting";

export type ResolutionType =
  | "GENERAL_CONSENT"
  | "RELATED_PARTY"
  | "PURCHASE_ORDER"
  | "TERM_EXTENSION"
  | "MANAGER_REMOVAL"
  | "SUCCESSOR_MANAGER"
  | "AMENDMENT"
  | "AUDIT_CALL"
  | "MEMBER_LOAN";

export const RESOLUTION_TYPES: readonly ResolutionType[] = [
  "GENERAL_CONSENT",
  "RELATED_PARTY",
  "PURCHASE_ORDER",
  "TERM_EXTENSION",
  "MANAGER_REMOVAL",
  "SUCCESSOR_MANAGER",
  "AMENDMENT",
  "AUDIT_CALL",
  "MEMBER_LOAN",
];

export interface RequirementSpec {
  requirement: Requirement;
  section: string;
}
export interface PresetContext {
  companyName: string;
}
export interface StarterBlock {
  type: "paragraph" | "heading";
  text: string;
} // converted to BlockNote blocks by the UI (G10)

export interface PresetBehaviour {
  hasBallots: boolean; // false only for PURCHASE_ORDER
  fixedWindowDays: number | null; // 30 for TERM_EXTENSION, else null (Manager chooses 1–180, default 30)
  deemedAgainstAtClose: boolean; // true only for TERM_EXTENSION (R14)
  allRecipientsRequired: boolean; // true for TERM_EXTENSION: every eligible Member must be asked
  copyToMembersBusinessDays: number | null; // 10 for PURCHASE_ORDER (R16), else null
  alsoFileUnder: "ARTICLES_AND_AGREEMENT" | null; // AMENDMENT
  kindLabel: string; // PDF heading
}

const VOTE_BASES = [
  "PREFERRED_MAJORITY",
  "PREFERRED_SUPERMAJORITY",
  "DISINTERESTED_MAJORITY",
  "DISINTERESTED_67",
  "DISINTERESTED_70",
] as const satisfies readonly VoteBasis[];

// ---------------------------------------------------------------------------
// Matter catalogue (R11)

const MANAGER: Requirement = { kind: "MANAGER_APPROVAL" };
const vote = (basis: VoteBasis): Requirement => ({ kind: "UNIT_VOTE", basis });
const SUPER = vote("PREFERRED_SUPERMAJORITY");

interface Matter {
  label: string;
  section: string;
  requirements: RequirementSpec[];
  presetType: ResolutionType | null;
}

function matter(
  label: string,
  section: string,
  requirements: Requirement[],
  presetType: ResolutionType | null = null,
): Matter {
  return {
    label,
    section,
    requirements: requirements.map((requirement) => ({ requirement, section })),
    presetType,
  };
}

export const MATTERS: Record<string, Matter> = {
  EARLY_ASSET_SALE: matter(
    "Sale of all or substantially all server assets closing before the Target Sale Date",
    "2.4, 6.16(d)",
    [SUPER],
  ),
  ADDITIONAL_COMMON_UNITS: matter("Issue additional Common Units", "3.2", [
    SUPER,
  ]),
  MEMBER_LOAN: matter(
    "Advance (loan) by a Member",
    "4.6, 6.16(d)",
    [SUPER],
    "MEMBER_LOAN",
  ),
  OBLIGATE_MEMBERS: matter(
    "Commit Members to fund capital, guarantee or increase personal liability",
    "6.16(a)",
    [SUPER],
  ),
  CHANGE_BUSINESS: matter("Materially change the business", "6.16(b)", [SUPER]),
  ACT_CONTRARY: matter("Action contrary to the Agreement", "6.16(c)", [SUPER]),
  BORROW_OR_PLEDGE: matter(
    "Indebtedness for borrowed money or pledge/security interest (other than trade payables and 6.16(i)(2) reimbursements)",
    "6.16(d)",
    [SUPER],
  ),
  ADDITIONAL_SERVERS: matter(
    "Acquire servers beyond those bought with accepted Capital Contributions",
    "6.16(d)",
    [SUPER],
  ),
  EARLY_DISSOLUTION: matter(
    "Dissolve before the sale of substantially all assets",
    "6.16(d), 11.1(b)",
    [MANAGER, SUPER],
  ),
  COMMINGLE: matter(
    "Co-mingle LLC funds (outside the 6.16(e) exception)",
    "6.16(e)",
    [SUPER],
  ),
  CONFESS_JUDGMENT: matter("Confess a judgment against the LLC", "6.16(f)", [
    SUPER,
  ]),
  ADMIT_MEMBER_OTHER: matter(
    "Admit a Member other than under 3.2, 4.9, 7",
    "6.16(g)",
    [SUPER],
  ),
  RELATED_PARTY: matter(
    "Transaction with Octagon Compute LLC, the Manager, Schoen, Reid or an Affiliate (not pre-approved)",
    "6.16(i)",
    [vote("DISINTERESTED_MAJORITY")],
    "RELATED_PARTY",
  ),
  ORG_EXPENSE_CAP: matter(
    "Organizational/offering expense reimbursement above $40,000 aggregate",
    "6.21",
    [SUPER],
  ),
  COMMON_TRANSFER_OR_CONTROL: matter(
    "Transfer of Common Units or change of control of the Manager (except to Reid, Schoen or an Affiliate controlled by them)",
    "7.1",
    [SUPER],
  ),
  TAX_PROCEEDING_ACTION: matter(
    "Settle, extend limitations or file a petition in a tax proceeding; direct not to make the push-out election",
    "9.2",
    [SUPER],
  ),
  INDEMNITY_SETTLEMENT: matter(
    "Indemnify amounts paid in settling an action by or in the right of the LLC where the Manager or its Affiliate is the Agent",
    "10.3(b)(ii)",
    [MANAGER, vote("DISINTERESTED_MAJORITY")],
  ),
  INDEMNITY_DETERMINATION: matter(
    "Determine that the Manager/Affiliate met the standard of conduct in a Proceeding brought by Members (alternative: independent counsel)",
    "10.5",
    [vote("DISINTERESTED_MAJORITY")],
  ),
  POST_TARGET_DISSOLUTION: matter(
    "Elect dissolution more than 180 days after the Target Sale Date if assets unsold",
    "11.1(d)",
    [SUPER],
  ),
  IN_KIND_DISTRIBUTION: matter(
    "In-kind distribution of servers or other non-cash assets",
    "11.4",
    [SUPER],
  ),
  TERM_EXTENSION: matter(
    "One-year extension of the operating term",
    "2.5",
    [vote("PREFERRED_MAJORITY")],
    "TERM_EXTENSION",
  ),
  AUDIT_CALL: matter(
    "Review or audit at the LLC's expense",
    "8.3",
    [vote("PREFERRED_MAJORITY")],
    "AUDIT_CALL",
  ),
  MANAGER_REMOVAL: matter(
    "Remove the Manager",
    "6.20",
    [vote("DISINTERESTED_67")],
    "MANAGER_REMOVAL",
  ),
  SUCCESSOR_MANAGER: matter(
    "Appoint a successor Manager (after removal or resignation)",
    "6.20",
    [vote("DISINTERESTED_MAJORITY")],
    "SUCCESSOR_MANAGER",
  ),
  AMENDMENT: matter(
    "Amend the Agreement",
    "12.1",
    [MANAGER, SUPER],
    "AMENDMENT",
  ),
  OTHER: matter("Any other matter reserved to the Members", "6.9", [SUPER]),
};

export const PROTECTED_PROVISIONS: readonly string[] = [
  "Section 2.4",
  "Section 2.5",
  "Section 4.8",
  "Section 4.9",
  "Section 5.6",
  "Section 6.16(d)",
  "Section 6.16(i)",
  "Section 6.18",
  "Section 6.20",
  "Section 6.21",
  "Section 11.4",
  "Last sentence of Section 6.9",
  "Section 7.1 (restriction on transfer of Common Units and change of control of the Manager)",
  "Section 12.1",
  "Definition of Available Cash",
  "Definition of Common Units",
  "Definition of Disinterested Preferred Units",
  "Definition of Preferred Majority",
  "Definition of Preferred Supermajority",
  "Definition of Preferred Units",
];

// ---------------------------------------------------------------------------
// Parameter schemas

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount such as 1000.00");
const positiveMoney = money.refine((v) => Number(v) > 0, "Must be above zero");
const ymd = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const generalConsentSchema = z.strictObject({
  matterKey: z
    .string()
    .trim()
    .refine(
      (key) => Object.hasOwn(MATTERS, key) && MATTERS[key]?.presetType === null,
      "Choose a matter that does not have its own resolution type",
    ),
  requireManagerApproval: z.boolean(),
  additionalBases: z.array(z.enum(VOTE_BASES)).default([]),
});

const relatedPartySchema = z.strictObject({
  counterparty: text(1, 200),
  relationship: text(1, 200),
  description: text(1, 2000),
  amount: money.optional(),
});

const purchaseOrderSchema = z.strictObject({
  vendor: text(1, 200),
  equipment: text(1, 2000),
  price: positiveMoney,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code")
    .default("USD"),
  poReference: text(0, 100),
  managerName: text(1, 200),
  purchasingAgentName: text(1, 200),
});

const termExtensionSchema = z.strictObject({
  currentTargetSaleDate: ymd,
  extensionNumber: z.number().int().min(1),
});

const managerRemovalSchema = z.strictObject({
  managerName: text(1, 200),
  requestedBy: text(0, 500),
});

const successorManagerSchema = z.strictObject({
  successorName: text(1, 200),
  reason: z.enum(["REMOVAL", "RESIGNATION"]),
});

const amendmentSchema = z
  .strictObject({
    summary: text(1, 2000),
    touchesProtectedProvision: z.boolean(),
    protectedSections: z.array(
      z.string().refine((s) => PROTECTED_PROVISIONS.includes(s), {
        message: "Not a provision listed in Section 12.1(c)",
      }),
    ),
    adverseToCommon: z.boolean(),
    affectedMemberIds: z
      .array(z.string().trim().min(1))
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate Member"),
  })
  .superRefine((value, ctx) => {
    if (
      value.touchesProtectedProvision !==
      value.protectedSections.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["protectedSections"],
        message: value.touchesProtectedProvision
          ? "Select at least one provision listed in Section 12.1(c)"
          : "Provisions may only be selected when the amendment touches a protected provision",
      });
    }
  });

const auditCallSchema = z.strictObject({
  fiscalYear: z.number().int().min(2026).max(2100),
  scope: z.enum(["REVIEW", "AUDIT"]),
  periodDescription: text(1, 500),
});

const memberLoanSchema = z.strictObject({
  lenderName: text(1, 200),
  lenderIsInsider: z.boolean(),
  principal: positiveMoney,
  interestRate: text(1, 100),
  maturity: text(1, 100),
});

const SCHEMAS = {
  GENERAL_CONSENT: generalConsentSchema,
  RELATED_PARTY: relatedPartySchema,
  PURCHASE_ORDER: purchaseOrderSchema,
  TERM_EXTENSION: termExtensionSchema,
  MANAGER_REMOVAL: managerRemovalSchema,
  SUCCESSOR_MANAGER: successorManagerSchema,
  AMENDMENT: amendmentSchema,
  AUDIT_CALL: auditCallSchema,
  MEMBER_LOAN: memberLoanSchema,
} satisfies Record<ResolutionType, z.ZodType>;

export type PresetParams = {
  [K in ResolutionType]: z.output<(typeof SCHEMAS)[K]>;
};

export function paramsSchema(type: ResolutionType): z.ZodType {
  return SCHEMAS[type];
}

/** Parse (and trim/default) params for a type; throws a ZodError when invalid. */
export function parseParams<T extends ResolutionType>(
  type: T,
  params: unknown,
): PresetParams[T] {
  return SCHEMAS[type].parse(params) as PresetParams[T];
}

// ---------------------------------------------------------------------------
// Requirements

function sameRequirement(a: Requirement, b: Requirement): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "UNIT_VOTE" && b.kind === "UNIT_VOTE")
    return a.basis === b.basis;
  if (
    a.kind === "AFFECTED_MEMBER_CONSENT" &&
    b.kind === "AFFECTED_MEMBER_CONSENT"
  )
    return a.stakeholderId === b.stakeholderId;
  return true;
}

function spec(requirement: Requirement, section: string): RequirementSpec {
  return { requirement, section };
}

export function buildRequirements(
  type: ResolutionType,
  params: unknown,
): RequirementSpec[] {
  switch (type) {
    case "GENERAL_CONSENT": {
      const p = parseParams(type, params);
      const m = MATTERS[p.matterKey] as Matter;
      const specs = m.requirements.map((s) => spec(s.requirement, s.section));
      const add = (requirement: Requirement, section: string) => {
        if (!specs.some((s) => sameRequirement(s.requirement, requirement)))
          specs.push(spec(requirement, section));
      };
      if (p.requireManagerApproval) add(MANAGER, m.section);
      for (const basis of p.additionalBases) add(vote(basis), "6.9");
      return specs;
    }
    case "RELATED_PARTY":
      parseParams(type, params);
      return [spec(vote("DISINTERESTED_MAJORITY"), "6.16(i)")];
    case "PURCHASE_ORDER":
      parseParams(type, params);
      return [spec(MANAGER, "6.16(i)(B)")];
    case "TERM_EXTENSION":
      parseParams(type, params);
      return [spec(vote("PREFERRED_MAJORITY"), "2.5")];
    case "MANAGER_REMOVAL":
      parseParams(type, params);
      return [spec(vote("DISINTERESTED_67"), "6.20")];
    case "SUCCESSOR_MANAGER":
      parseParams(type, params);
      return [spec(vote("DISINTERESTED_MAJORITY"), "6.20")];
    case "AMENDMENT": {
      const p = parseParams(type, params);
      const specs = [spec(MANAGER, "12.1"), spec(SUPER, "12.1")];
      if (p.touchesProtectedProvision)
        specs.push(spec(vote("DISINTERESTED_70"), "12.1(c)"));
      if (p.adverseToCommon)
        specs.push(spec({ kind: "COMMON_MEMBER_APPROVAL" }, "12.1(d)"));
      for (const stakeholderId of p.affectedMemberIds)
        specs.push(
          spec({ kind: "AFFECTED_MEMBER_CONSENT", stakeholderId }, "12.1(b)"),
        );
      return specs;
    }
    case "AUDIT_CALL":
      parseParams(type, params);
      return [spec(vote("PREFERRED_MAJORITY"), "8.3")];
    case "MEMBER_LOAN": {
      const p = parseParams(type, params);
      const specs = [spec(SUPER, "4.6; 6.16(d)")];
      if (p.lenderIsInsider)
        specs.push(spec(vote("DISINTERESTED_MAJORITY"), "6.16(i)"));
      return specs;
    }
  }
}

// ---------------------------------------------------------------------------
// Delivery behaviour

export function behaviour(type: ResolutionType): PresetBehaviour {
  const isTermExtension = type === "TERM_EXTENSION";
  const isPurchaseOrder = type === "PURCHASE_ORDER";
  return {
    hasBallots: !isPurchaseOrder,
    fixedWindowDays: isTermExtension ? 30 : null,
    deemedAgainstAtClose: isTermExtension,
    allRecipientsRequired: isTermExtension,
    copyToMembersBusinessDays: isPurchaseOrder ? 10 : null,
    alsoFileUnder: type === "AMENDMENT" ? "ARTICLES_AND_AGREEMENT" : null,
    kindLabel: isPurchaseOrder
      ? "Written Resolution of the Manager"
      : "Action by Written Consent of the Members",
  };
}
