import { z } from "zod";
import states from "../../../lib/states";

// Literal value lists (mirrors of the Prisma enums) so this module needs no
// runtime import of `@/prisma/enums` and can be unit tested.
export const HOLDER_TYPES = ["INDIVIDUAL", "JOINT", "TRUST", "ENTITY"] as const;
export const ACCREDITATION_BASES = [
  "NET_WORTH",
  "INCOME",
  "LICENSE",
  "ENTITY_ASSETS",
  "ENTITY_ALL_OWNERS_ACCREDITED",
  "TRUST_ASSETS",
] as const;
export const MEMBER_STATUSES = [
  "PROSPECT",
  "MEMBER",
  "FINANCIAL_INTEREST_ONLY",
] as const;
export const MEMBER_DOCUMENT_KINDS = [
  "exhibit-b",
  "w9",
  "wire-confirmation",
  "other",
] as const;

const STATE_CODES = new Set(states.map((s) => s.abbreviation));

const ZStateCode = z
  .string()
  .length(2)
  .refine((v) => STATE_CODES.has(v), { message: "Invalid state code" });

const ZMemberFields = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  holderType: z.enum(HOLDER_TYPES),
  residenceState: ZStateCode.optional(),
  accreditationBasis: z.enum(ACCREDITATION_BASES).optional(),
  signerName: z.string().trim().max(120).optional(),
  signerTitle: z.string().trim().max(120).optional(),
  noticeEmail: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().max(40).optional(),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  state: ZStateCode.optional(),
  zipcode: z.string().optional(),
  isInsider: z.boolean(),
});

type MemberFields = z.infer<typeof ZMemberFields>;

const signerRequired = (v: Pick<MemberFields, "holderType" | "signerName">) =>
  !(v.holderType === "TRUST" || v.holderType === "ENTITY") || !!v.signerName;

const signerIssue = {
  message: "Signer name is required for trusts and entities",
  path: ["signerName"],
};

export const ZMemberInput = ZMemberFields.refine(signerRequired, signerIssue);
export const ZCreateMemberInput = ZMemberFields.omit({ id: true }).refine(
  signerRequired,
  signerIssue,
);
export const ZUpdateMemberInput = ZMemberFields.extend({
  id: z.string(),
}).refine(signerRequired, signerIssue);

export type TMemberInput = z.infer<typeof ZMemberInput>;

export const ZSetMemberStatusInput = z.object({
  id: z.string(),
  memberStatus: z.enum(["MEMBER", "FINANCIAL_INTEREST_ONLY"]),
  reason: z.string().trim().min(5),
});

export const ZAttachDocumentInput = z.object({
  stakeholderId: z.string(),
  bucketId: z.string(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(MEMBER_DOCUMENT_KINDS),
});

export type MemberDTO = {
  id: string;
  name: string;
  email: string;
  noticeEmail: string | null;
  effectiveNoticeEmail: string;
  holderType: (typeof HOLDER_TYPES)[number] | null;
  residenceState: string | null;
  accreditationBasis: (typeof ACCREDITATION_BASES)[number] | null;
  admittedOn: string | null;
  signerName: string | null;
  signerTitle: string | null;
  phone: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  isInsider: boolean;
  memberStatus: (typeof MEMBER_STATUSES)[number];
  createdAt: string;
};
