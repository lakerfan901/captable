import { z } from "zod";
import { zCents, zId, zIsoDate } from "@/trpc/routers/llc-shared/schema";

const zInt = z.number().int().min(0).max(100_000);

/** Parameters, interpretation switches and calendar columns of `LlcTerm` (partial). */
export const ZLlcTermUpdateSchema = z
  .object({
    // Dates
    replacementFunderOutsideDate: zIsoDate,
    // Parameters
    callNoticeBusinessDays: zInt,
    forfeitureCureBusinessDays: zInt,
    creditDateMaxDays: zInt,
    defaultInterestBps: zInt,
    defaultInterestDayBasis: zInt.min(1),
    forfeitureBps: zInt,
    replacementCreditBps: zInt,
    managementFeeBps: zInt,
    minimumOperatingReserveCents: zCents,
    orgExpenseCapCents: zCents,
    distributionDeadlineDays: zInt,
    targetSaleYears: zInt,
    loiExtensionMaxDays: zInt,
    extensionRequestMonthsBefore: zInt,
    extensionConsentWindowDays: zInt,
    dissolutionElectionDays: zInt,
    ocdNoticeBusinessDays: zInt,
    // Interpretation switches
    prefAccrualCutoff: z.enum(["PAYMENT_DATE", "PERIOD_END"]),
    accrueOnDefaulterCapital: z.boolean(),
    capitalReturnLotOrder: z.enum(["PRO_RATA", "FIFO", "LIFO"]),
    forfeitureBaseNetOfReplacementFunding: z.boolean(),
    defaultOffsetOrder: z.enum([
      "BALANCE_INTEREST_COSTS",
      "COSTS_INTEREST_BALANCE",
    ]),
    includeInsiderDistributionsInManagerList: z.boolean(),
    // Calendar
    holidayCalendar: z.enum(["US_FEDERAL", "NONE"]),
    saturdayHolidayObservedFriday: z.boolean(),
    extraHolidays: z.array(zIsoDate).max(50),
  })
  .partial()
  .strict();
export type TLlcTermUpdate = z.infer<typeof ZLlcTermUpdateSchema>;

export const ZSetOperationsCommencementDateSchema = z.object({
  date: zIsoDate,
  noticeSentOn: zIsoDate.nullable(),
});

export const ZSetLoiExtensionSchema = z.object({
  days: zInt,
  loiDocumentId: zId.nullable(),
});

export const ZReopenBooksSchema = z.object({
  through: zIsoDate.nullable(),
  reason: z.string().trim().min(10).max(2000),
});

/** Columns frozen once the economics have history (they would rewrite it). */
export const LOCKED_TERM_FIELDS = [
  "prefAccrualCutoff",
  "accrueOnDefaulterCapital",
  "capitalReturnLotOrder",
  "forfeitureCureBusinessDays",
  "forfeitureBps",
  "forfeitureBaseNetOfReplacementFunding",
  "replacementCreditBps",
  "defaultInterestBps",
  "defaultInterestDayBasis",
  "defaultOffsetOrder",
  "callNoticeBusinessDays",
  "creditDateMaxDays",
  "holidayCalendar",
  "saturdayHolidayObservedFriday",
] as const satisfies readonly (keyof TLlcTermUpdate)[];
