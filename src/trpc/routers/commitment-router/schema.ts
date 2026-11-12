import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import { ZCents } from "@/lib/money";

export const ZCommitmentStatus = z.enum([
  "PENDING",
  "ACCEPTED",
  "REDUCED",
  "REJECTED",
]);

export const ZAccreditationBasis = z.enum([
  "NET_WORTH",
  "INCOME",
  "LICENSE",
  "ENTITY_ASSETS",
  "ENTITY_ALL_OWNERS_ACCREDITED",
  "TRUST_ASSETS",
]);

const ZId = z.string().min(1);
const ZPositiveCents = ZCents.min(1, "The amount must be more than zero.");

export const ZodListCommitmentsSchema = z
  .object({
    stakeholderId: ZId.optional(),
    status: ZCommitmentStatus.optional(),
  })
  .default({});

export const ZodGetCommitmentSchema = z.object({ id: ZId });

export const ZodListReceiptsSchema = z
  .object({
    stakeholderId: ZId.optional(),
    includeVoided: z.boolean().optional(),
  })
  .default({});

export const ZodCreateCommitmentSchema = z.object({
  stakeholderId: ZId,
  committedCents: ZPositiveCents,
  signedOn: ZDateOnly.optional(),
  investmentSummaryDate: ZDateOnly.optional(),
  accreditationBasis: ZAccreditationBasis.optional(),
  notes: z.string().max(2000).optional(),
});

export const ZodUpdateCommitmentSchema = z.object({
  id: ZId,
  committedCents: ZPositiveCents.optional(),
  // `null` clears the date; leaving the key out keeps the stored value.
  signedOn: ZDateOnly.nullable().optional(),
  investmentSummaryDate: ZDateOnly.nullable().optional(),
  accreditationBasis: ZAccreditationBasis.optional(),
  notes: z.string().max(2000).optional(),
});

export const ZodAcceptCommitmentSchema = z.object({
  id: ZId,
  acceptedOn: ZDateOnly,
  acceptedCents: ZCents.optional(),
  keepCents: ZCents.optional(),
  minimumWaived: z.boolean().optional(),
  minimumWaiverNote: z.string().optional(),
});

export const ZodRejectCommitmentSchema = z.object({
  id: ZId,
  decidedOn: ZDateOnly,
  reason: z.string().min(3),
});

export const ZodRecordRefundSchema = z.object({
  id: ZId,
  paidCents: ZPositiveCents,
  paidOn: ZDateOnly,
});

export const ZodRecordReceiptSchema = z.object({
  commitmentId: ZId,
  receivedOn: ZDateOnly,
  amountCents: ZPositiveCents,
  reference: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
});

export const ZodVoidReceiptSchema = z.object({
  receiptId: ZId,
  reason: z.string().min(5),
});

export const ZodIssueCommonUnitsSchema = z.object({
  stakeholderId: ZId,
  units: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "Up to 6 decimals, e.g. 100 or 40.25"),
  issuedOn: ZDateOnly,
});
