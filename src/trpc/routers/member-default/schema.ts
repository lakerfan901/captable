import { z } from "zod";
import {
  zCents,
  zId,
  zIsoDate,
  zPositiveCents,
  zUnits,
} from "@/trpc/routers/llc-shared/schema";

export const ZMemberDefaultIdSchema = z.object({ id: zId });

/** `expectedUnpaidCents` = the unpaid amount at the due date shown by `overdue` (`unpaidAtDue`). */
export const ZDeclareSchema = z.object({
  callNoticeLineId: zId,
  expectedUnpaidCents: zPositiveCents,
});

export const ZVoidSchema = z.object({
  id: zId,
  reason: z.string().trim().min(10).max(500),
});

export const ZAddChargeSchema = z.object({
  id: zId,
  incurredOn: zIsoDate,
  amountCents: zPositiveCents,
  description: z.string().trim().min(1).max(500),
  documentId: zId.optional(),
});

export const ZRecordFundingSchema = z.object({
  id: zId,
  funderStakeholderId: zId,
  amountCents: zPositiveCents,
  fundedOn: zIsoDate,
  reference: z.string().trim().max(120).optional(),
});

export const ZRecordDefaultPaymentSchema = z.object({
  id: zId,
  paidOn: zIsoDate,
  amountCents: zPositiveCents,
  expected: z.object({
    toBalanceCents: zCents,
    toInterestCents: zCents,
    toCostsCents: zCents,
  }),
});

/** Read-only preview of `recordPayment`'s split (its `expected`). */
export const ZPreviewDefaultPaymentSchema = z.object({
  id: zId,
  paidOn: zIsoDate,
  amountCents: zPositiveCents,
});

export const ZConfirmForfeitureSchema = z.object({
  id: zId,
  expectedForfeitedCents: zCents,
  expectedUnitsAfter: zUnits,
});

export const ZConfirmCreditSchema = z.object({
  id: zId,
  expectedPoolACents: zCents,
  expectedPoolBCents: zCents,
  /** optional extra check: the Credit Date the Manager reviewed */
  expectedCreditDate: zIsoDate.optional(),
});

export const ZConfirmCureSchema = z.object({
  id: zId,
  expectedCuredOn: zIsoDate,
});
