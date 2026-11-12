import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import { ZCents } from "@/lib/money";

const ZUnits = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "Up to 6 decimals, e.g. 100 or 40.25");

export const ZBalanceReturnStartRule = z.enum([
  "LATER_OF_RECEIPT_AND_DUE",
  "RECEIPT_DATE",
]);

export const ZodUpdateUnitClassSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  pricePerUnitCents: ZCents.nullable(),
  authorizedUnits: ZUnits.nullable(),
  fractionalUnitsAllowed: z.boolean(),
  votesPerUnit: ZUnits,
  prefReturnBps: z.number().int().min(0).max(10000),
  balanceReturnStartRule: ZBalanceReturnStartRule,
  residualSplitBps: z.number().int().min(0).max(10000),
  minCommitmentCents: ZCents.nullable(),
  minCommitmentFloorCents: ZCents.nullable(),
  offeringCapCents: ZCents.nullable(),
  initialInstallmentBps: z.number().int().min(1).max(10000),
  finalClosingDate: ZDateOnly.nullable(),
  balanceOutsideDate: ZDateOnly.nullable(),
  acceptanceBusinessDays: z.number().int().min(1).max(60),
  refundBusinessDays: z.number().int().min(1).max(60),
  confirmAmendment: z.boolean().default(false),
  amendmentReason: z.string().optional(),
});

export type TypeZodUpdateUnitClassSchema = z.infer<
  typeof ZodUpdateUnitClassSchema
>;

/** Wire shape of a unit class (cents as number, units as 6-dp string). */
export type UnitClassDTO = {
  id: string;
  name: string;
  kind: "PREFERRED" | "COMMON";
  pricePerUnitCents: number | null;
  authorizedUnits: string | null;
  issuedUnits: string;
  fractionalUnitsAllowed: boolean;
  votesPerUnit: string;
  prefReturnBps: number;
  prefReturnDayCount: "ACTUAL_365";
  balanceReturnStartRule: z.infer<typeof ZBalanceReturnStartRule>;
  residualSplitBps: number;
  minCommitmentCents: number | null;
  minCommitmentFloorCents: number | null;
  offeringCapCents: number | null;
  initialInstallmentBps: number;
  finalClosingDate: string | null;
  balanceOutsideDate: string | null;
  acceptanceBusinessDays: number;
  refundBusinessDays: number;
  termsLocked: boolean;
};
