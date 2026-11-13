import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import {
  CONSENT_VALUES,
  ROFR_OUTCOMES,
  SECURITIES_OPINIONS,
  TRANSFER_KINDS,
  TRANSFER_STATUSES,
} from "@/lib/governance/transfer-core";
import { CENTS_MAX } from "@/lib/money";

// Inputs of the unit transfer router (03-governance.md G16). Client-safe:
// zod and pure modules only, so the transfers UI (G17) may import these.
// Every object is strict and every string bounded.
//
// `update` takes only the fields being changed. Fields that may be cleared
// accept `null` (absent = unchanged, null = cleared).

const zId = z.string().trim().min(1).max(64);
const zPublicId = z.string().trim().min(1).max(64);

/** Positive decimal with at most 6 decimal places ("50", "25.5", "0.000001"). */
const zUnits = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, "Up to 6 decimals, e.g. 100 or 40.25")
  .refine((s) => /[1-9]/.test(s), "Enter more than zero units.");

const zCents = z.number().int().min(0).max(CENTS_MAX);
const zNote = (max: number) => z.string().trim().max(max);

export const ZTransferKind = z.enum(TRANSFER_KINDS);
export const ZTransferStatus = z.enum(TRANSFER_STATUSES);
/** NOT_APPLICABLE is set by the server only (kinds without a ROFR). */
export const ZRofrOutcomeInput = z
  .enum(ROFR_OUTCOMES)
  .exclude(["NOT_APPLICABLE"]);
/** NOT_REQUIRED is set by the server only (kinds other than VOLUNTARY). */
export const ZManagerConsentInput = z
  .enum(CONSENT_VALUES)
  .exclude(["NOT_REQUIRED"]);

export const ZUnitTransferListSchema = z
  .object({ status: ZTransferStatus.optional() })
  .strict();

export const ZUnitTransferGetSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZUnitTransferCreateSchema = z
  .object({
    kind: ZTransferKind,
    fromStakeholderId: zId,
    toStakeholderId: zId.optional(),
    unitClassId: zId,
    units: zUnits,
    /** Date the Transfer Notice (or notice of the transfer) was received; not in the future. */
    noticeReceivedOn: ZDateOnly,
    proposedPriceCents: zCents.optional(),
    terms: zNote(4000).optional(),
    bonaFideOffer: z.boolean().optional(),
    notes: zNote(4000).optional(),
  })
  .strict();

export const ZUnitTransferUpdateSchema = z
  .object({
    publicId: zPublicId,
    toStakeholderId: zId.nullable().optional(),
    proposedPriceCents: zCents.nullable().optional(),
    terms: zNote(4000).nullable().optional(),
    bonaFideOffer: z.boolean().optional(),
    rofrOutcome: ZRofrOutcomeInput.optional(),
    rofrDecidedOn: ZDateOnly.nullable().optional(),
    rofrNote: zNote(2000).nullable().optional(),
    managerConsent: ZManagerConsentInput.optional(),
    managerConsentOn: ZDateOnly.nullable().optional(),
    managerConsentNote: zNote(2000).nullable().optional(),
    securitiesOpinion: z.enum(SECURITIES_OPINIONS).nullable().optional(),
    /** Once set it can be moved but not cleared (its deadline stays). */
    priceEstablishedOn: ZDateOnly.optional(),
    transferNoticeOn: ZDateOnly.nullable().optional(),
    requiredResolutionPublicId: zPublicId.nullable().optional(),
    exemptUnder71: z.boolean().optional(),
    exemptNote: zNote(2000).nullable().optional(),
    admissionSignaturePage: z.boolean().optional(),
    admissionExpensesPaid: z.boolean().optional(),
    admissionQualified: z.boolean().optional(),
    admissionManagerConsent: z.boolean().optional(),
    notes: zNote(4000).nullable().optional(),
  })
  .strict();

export const ZUnitTransferCreateNoticeCopySchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZUnitTransferCancelSchema = z
  .object({ publicId: zPublicId, reason: z.string().trim().min(1).max(500) })
  .strict();

export const ZUnitTransferCompleteSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZUnitTransferAdmitSchema = z
  .object({ publicId: zPublicId, admittedOn: ZDateOnly })
  .strict();

/** The four admission fields `update` accepts after COMPLETED (C3.8). */
export const ADMISSION_FIELDS = [
  "admissionSignaturePage",
  "admissionExpensesPaid",
  "admissionQualified",
  "admissionManagerConsent",
] as const;
