import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import { ZCents } from "@/lib/money";
import states from "@/lib/states";
import { W9_CONTENT_TYPES, W9_MAX_BYTES } from "@/server/llc/admission";
import {
  ACCREDITATION_BASES,
  HOLDER_TYPES,
} from "../stakeholder-router/member-schema";

// Inputs of the admission router (01-foundation.md F12).

const ZPublicId = z.string().min(1).max(64);

export const ZodCreateMasterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bucketId: z.string().min(1).max(64),
});

export const ZodPacketPublicIdSchema = z.object({ publicId: ZPublicId });

export const ZodSendSubscriptionSchema = z
  .object({
    masterPublicId: ZPublicId,
    stakeholderId: z.string().min(1).max(64).optional(),
    prospect: z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().toLowerCase().email().max(254),
      })
      .optional(),
    managerMemberId: z.string().min(1).max(64),
    message: z.string().max(2000).optional(),
  })
  .refine(
    (v) => (v.stakeholderId === undefined) !== (v.prospect === undefined),
    {
      message: "Choose an existing person or enter a new one, not both.",
    },
  );

// ---------------------------------------------------------------------------
// Manager confirmation (F13)

const STATE_CODES = new Set(states.map((s) => s.abbreviation));
const ZStateCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => STATE_CODES.has(v), { message: "Choose a US state." });
const ZRequiredText = (max: number) => z.string().trim().min(1).max(max);
/** `undefined` keeps the stored value, `null` clears it, a string sets it. */
const ZOptionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

export const ZodConfirmDetailsSchema = z.object({
  publicId: ZPublicId,
  stakeholder: z
    .object({
      name: ZRequiredText(200),
      holderType: z.enum(HOLDER_TYPES),
      residenceState: ZStateCode,
      accreditationBasis: z.enum(ACCREDITATION_BASES),
      streetAddress: ZRequiredText(200),
      city: ZRequiredText(120),
      state: ZStateCode,
      zipcode: ZRequiredText(20),
      noticeEmail: z
        .string()
        .trim()
        .toLowerCase()
        .email()
        .max(254)
        .nullable()
        .optional(),
      signerName: ZOptionalText(120),
      signerTitle: ZOptionalText(120),
      phone: ZOptionalText(40),
      isInsider: z.boolean(),
    })
    .refine(
      (v) =>
        !(v.holderType === "TRUST" || v.holderType === "ENTITY") ||
        (v.signerName !== null && v.signerName !== ""),
      {
        message: "Signer name is required for trusts and entities",
        path: ["signerName"],
      },
    ),
  commitment: z.object({
    committedCents: ZCents.min(
      1,
      "The committed amount must be more than zero.",
    ),
    signedOn: ZDateOnly,
    investmentSummaryDate: ZDateOnly,
  }),
  /**
   * What the Manager saw (from `admission.get`): the packet's commitment id
   * and the member record's version. A difference is a CONFLICT.
   */
  expected: z.object({
    commitmentId: z.string().min(1).max(64).nullable(),
    stakeholderVersion: z.string().min(1).max(64),
  }),
  /**
   * Whether the confirmed details are written to the member record. Required
   * when the person is already a Member (or holds a Financial Interest): an
   * admitted Member's register entry is never changed implicitly. A
   * prospect's record is always written.
   */
  updateMemberRecord: z.boolean().optional(),
});

export const ZodRejectPacketSchema = z.object({
  publicId: ZPublicId,
  decidedOn: ZDateOnly,
  reason: z.string().trim().min(3).max(2000),
});

export const ZodReassignManagerSchema = z.object({
  publicId: ZPublicId,
  managerMemberId: z.string().min(1).max(64),
});

export const ZodPrepareCountersignSchema = z.object({
  publicId: ZPublicId,
  /** The figures the Manager saw (`admission.get` → `countersign`). */
  expectedReceivedCents: ZCents,
  expectedUnits: z.string().regex(/^-?\d+(\.\d{1,6})?$/),
});

/** A W-9 link token (a JWT); bounded so a huge string is refused before it is verified. */
const ZW9Token = z.string().min(20).max(2048);

export const ZodW9InfoSchema = z.object({ token: ZW9Token });

export const ZodW9UploadUrlSchema = z.object({
  token: ZW9Token,
  // Accepted for the client's convenience; never stored, logged or put in the key.
  fileName: z.string().min(1).max(200),
  contentType: z.enum(W9_CONTENT_TYPES),
  size: z.number().int().min(1).max(W9_MAX_BYTES),
});

export const ZodW9CompleteSchema = z.object({
  token: ZW9Token,
  key: z.string().min(1).max(512),
});
