import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import { ZCents } from "@/lib/money";

export const zIsoDate = ZDateOnly; // "YYYY-MM-DD"
export const zCents = ZCents; // integer cents as a JS number, >= 0
export const zPositiveCents = ZCents.min(1);
export const zUnits = z.string().regex(/^\d+(\.\d{1,6})?$/);
export const zId = z.string().min(1).max(64);
export const zMemo = z.string().trim().max(2000);
