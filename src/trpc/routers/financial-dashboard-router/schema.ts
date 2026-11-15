// Inputs of the team's financial dashboard procedures (04-investor-portal.md
// 5.9 "Procedures"; package P13b). Safe for the browser (no server import),
// so a form can validate with these schemas.
import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import {
  RESTATE_REASON_MAX_LENGTH as RESTATE_REASON_MAX,
  RESTATE_REASON_MIN_LENGTH as RESTATE_REASON_MIN,
} from "@/lib/llc/financial-dashboard-core";
import { isMonthKey } from "@/lib/llc/financial-periods";

/** A month, as its first day ("2026-02-01"). */
export const ZMonthKey = z
  .string()
  .refine(isMonthKey, "Give a month as its first day (YYYY-MM-01).");

/** `financialDashboard.live`: the last date to show (default: today). */
export const ZLiveInput = z
  .object({ through: ZDateOnly.optional() })
  .strict()
  .optional();

/** `financialDashboard.published`: with `asHolder` (a `Stakeholder.id`), "Preview as" that holder. */
export const ZPublishedInput = z
  .object({ asHolder: z.string().min(1).max(64).optional() })
  .strict()
  .optional();

const REASON_RULE = `The reason must be ${RESTATE_REASON_MIN} to ${RESTATE_REASON_MAX} characters.`;

/** `financialDashboard.restate` (P35). */
export const ZRestateInput = z
  .object({
    fromMonth: ZMonthKey,
    toMonth: ZMonthKey,
    reason: z
      .string()
      .trim()
      .min(RESTATE_REASON_MIN, REASON_RULE)
      .max(RESTATE_REASON_MAX, REASON_RULE),
  })
  .strict();
