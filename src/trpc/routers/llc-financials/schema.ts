import { z } from "zod";
import {
  ExpenseCategoryEnum,
  FundingSourceEnum,
  ManagerPaymentCategoryEnum,
  MemberAdvanceKindEnum,
  ReserveKindEnum,
} from "@/prisma/enums";
import {
  zCents,
  zId,
  zIsoDate,
  zMemo,
  zPositiveCents,
} from "@/trpc/routers/llc-shared/schema";

export const zExpenseCategory = z.enum(ExpenseCategoryEnum);
export const zFundingSource = z.enum(FundingSourceEnum);
export const zManagerPaymentCategory = z.enum(ManagerPaymentCategoryEnum);
export const zReserveKind = z.enum(ReserveKindEnum);
export const zMemberAdvanceKind = z.enum(MemberAdvanceKindEnum);

const zReason = z.string().trim().min(5).max(2000);
const zPayee = z.string().trim().min(1).max(200);

export const ZDateRangeSchema = z.object({ from: zIsoDate, to: zIsoDate });
export const ZAsOfSchema = z.object({ asOf: zIsoDate.optional() });
export const ZReverseSchema = z.object({ id: zId, reason: zReason });

// Revenue
export const ZRevenueListSchema = z.object({
  year: z.number().int().min(2020).max(2100),
});
export const ZRevenueSaveSchema = z.object({
  month: zIsoDate.refine((s) => s.endsWith("-01"), {
    message: "Use the first day of the month.",
  }),
  customerReceiptsCents: zCents,
  passThroughFeesCents: zCents,
  otherIncomeCents: zCents,
  assetSaleProceedsCents: zCents,
  insuranceProceedsCents: zCents,
  utilizationBps: z.number().int().min(0).max(10_000).nullable(),
  notes: zMemo.nullable(),
});
export type TRevenueSave = z.infer<typeof ZRevenueSaveSchema>;

// Expenses
export const ZExpenseFields = z.object({
  category: zExpenseCategory,
  fundingSource: zFundingSource.optional(),
  countsTowardOrgCap: z.boolean().optional(),
});
export const ZExpenseCreateSchema = ZExpenseFields.extend({
  incurredOn: zIsoDate,
  payee: zPayee,
  amountCents: zPositiveCents,
  memo: zMemo.nullable(),
  documentId: zId.nullable().optional(),
  resolutionId: zId.nullable().optional(),
});
export type TExpenseCreate = z.infer<typeof ZExpenseCreateSchema>;

// Manager payments
export const ZManagerPaymentCreateSchema = z.object({
  paidOn: zIsoDate,
  payee: zPayee,
  payeeStakeholderId: zId.nullable().optional(),
  amountCents: zPositiveCents,
  category: zManagerPaymentCategory,
  memo: zMemo.nullable(),
  documentId: zId.nullable().optional(),
  resolutionId: zId.nullable().optional(),
  countsTowardOrgCap: z.boolean(),
  expense: z
    .object({
      category: zExpenseCategory,
      fundingSource: zFundingSource,
      countsTowardOrgCap: z.boolean(),
    })
    .nullable(),
});
export type TManagerPaymentCreate = z.infer<typeof ZManagerPaymentCreateSchema>;

// Reserves
export const ZReserveEstablishSchema = z.object({
  effectiveOn: zIsoDate,
  kind: zReserveKind,
  amountCents: zPositiveCents,
  fundingSource: zFundingSource,
  reason: zReason,
});
export const ZReserveReleaseSchema = z.object({
  effectiveOn: zIsoDate,
  kind: zReserveKind,
  amountCents: zPositiveCents,
  fundingSource: zFundingSource,
  releaseTo: zFundingSource.nullable().optional(),
  reason: zReason,
  allowBelowMinimum: z.boolean(),
});

// Member loans
export const ZLoanCreateSchema = z
  .object({
    lenderStakeholderId: zId,
    principalCents: zPositiveCents,
    interestBps: z.number().int().min(0).max(5_000),
    madeOn: zIsoDate,
    maturityOn: zIsoDate,
    noteDocumentId: zId,
    resolutionId: zId.nullable(),
    notes: zMemo.nullable(),
  })
  .refine((v) => v.maturityOn > v.madeOn, {
    message: "The maturity date must be after the loan date.",
    path: ["maturityOn"],
  })
  .refine((v) => v.resolutionId !== null || (v.notes ?? "").length >= 10, {
    message:
      "Without a resolution, describe the Preferred Supermajority approval in the notes (at least 10 characters).",
    path: ["notes"],
  });
export const ZLoanPaymentSchema = z
  .object({
    memberLoanId: zId,
    paidOn: zIsoDate,
    principalCents: zCents,
    interestCents: zCents,
    fundingSource: zFundingSource,
  })
  .refine((v) => v.principalCents + v.interestCents > 0, {
    message: "Enter a principal or interest amount.",
    path: ["principalCents"],
  });

// Tax advances
export const ZAdvanceCreateSchema = z.object({
  stakeholderId: zId,
  paidOn: zIsoDate,
  kind: zMemberAdvanceKind,
  amountCents: zPositiveCents,
  jurisdiction: z.string().trim().max(100).nullable().optional(),
  taxYear: z.number().int().min(2000).max(2100).nullable().optional(),
  memo: zMemo.nullable(),
  documentId: zId.nullable().optional(),
});
export const ZAdvanceRepaymentSchema = z.object({
  stakeholderId: zId,
  recoveredOn: zIsoDate,
  amountCents: zPositiveCents,
});
