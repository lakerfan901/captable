// Inputs of the dashboard exports (04-investor-portal.md 5.9 "Procedures":
// `portal.financials.exportXlsx` and `financialDashboard.exportXlsx`;
// package P17). Safe for the browser (no server import).
//
// The view on screen: the columns the charts plot (`grain` over `from`–`to`,
// the trend of `resolveView`), the period the tiles describe (`focus`) and
// the comparison. The server clamps `to` to what the viewer may see.

import { z } from "zod";
import { isMonthKey } from "../llc/financial-periods";

const ZMonth = z
  .string()
  .refine(isMonthKey, "Give a month as its first day (YYYY-MM-01).");

/** At most this many months in one export (100 years). */
export const MAX_EXPORT_MONTHS = 1_200;

/** Months from `from` through `to` (no throw: zod runs this on malformed input too). */
function monthCount(from: string, to: string): number {
  const n = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  const count = n(to) - n(from) + 1;
  return Number.isFinite(count) ? count : Number.POSITIVE_INFINITY;
}

export const ZFinancialsExportView = z
  .object({
    view: z.enum(["fund", "mine"]),
    grain: z.enum(["month", "quarter", "year"]),
    from: ZMonth,
    to: ZMonth,
    /** the selected period: "2026-Q3", "2026-07", "2026" or "inception" */
    focus: z
      .string()
      .regex(/^(inception|\d{4}(-\d{2}|-Q[1-4])?)$/)
      .nullish(),
    compare: z.enum(["previous", "yearAgo", "none"]).default("previous"),
  })
  .refine((v) => v.from <= v.to, {
    message: "The range ends before it starts.",
    path: ["to"],
  })
  .refine((v) => monthCount(v.from, v.to) <= MAX_EXPORT_MONTHS, {
    message: "The range is too long.",
    path: ["to"],
  });

export type FinancialsExportView = z.infer<typeof ZFinancialsExportView>;
