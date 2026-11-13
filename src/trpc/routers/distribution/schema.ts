import { z } from "zod";
import { zCents, zId, zIsoDate, zMemo } from "@/trpc/routers/llc-shared/schema";

export const ZDistributionTypeSchema = z.enum([
  "OPERATING",
  "RETURN_OF_UNUSED_CAPITAL",
  "SALE_OR_LIQUIDATION",
]);

const ZLiquidationSchema = z.object({
  cashAvailableCents: zCents,
  windDownReserveCents: zCents,
  creditors: z
    .array(
      z.object({
        payee: z.string().trim().min(1).max(200),
        amountCents: zCents,
        memo: z.string().trim().max(500),
        managerCategory: z
          .enum(["MANAGEMENT_FEE", "EXPENSE_REIMBURSEMENT"])
          .nullable(),
      }),
    )
    .max(100),
  isFinal: z.boolean(),
});

/** `DistributionInputs` (E15): stored as received in `Distribution.inputs`; cents are JSON numbers. */
export const ZDistributionInputsSchema = z.union([
  z.object({ type: z.literal("OPERATING") }),
  z.object({
    type: z.literal("RETURN_OF_UNUSED_CAPITAL"),
    amountCents: zCents,
  }),
  z.object({
    type: z.literal("SALE_OR_LIQUIDATION"),
    liquidation: ZLiquidationSchema.nullable(),
  }),
]);

export const ZDistributionIdSchema = z.object({ id: zId });

export const ZSaveDraftSchema = z
  .object({
    id: zId.optional(),
    type: ZDistributionTypeSchema,
    periodStart: zIsoDate.nullable().optional(),
    periodEnd: zIsoDate,
    paymentDate: zIsoDate,
    inputs: ZDistributionInputsSchema,
    notes: zMemo.nullable().optional(),
  })
  .refine((v) => v.inputs.type === v.type, {
    message: "The inputs do not match the distribution type.",
    path: ["inputs"],
  })
  .refine((v) => !v.periodStart || v.periodStart <= v.periodEnd, {
    message: "The period start must not be after the period end.",
    path: ["periodStart"],
  });

export const ZFinalizeSchema = z.object({
  id: zId,
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  solvencyConfirmed: z.literal(true),
});

export const ZReverseSchema = z.object({
  id: zId,
  reason: z.string().trim().min(10).max(500),
});
