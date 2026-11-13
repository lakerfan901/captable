import { z } from "zod";
import { ZDateOnly } from "@/lib/date-only";
import { CUSTOM_DEADLINE_TEMPLATE_KEYS } from "@/lib/governance/compliance-core";

// Inputs of the compliance calendar router (03-governance.md G14).
// Client-safe: zod and pure modules only, so the calendar UI (G15) may import
// these. Every object is strict and every string bounded.

const zId = z.string().trim().min(1).max(64);
const zPublicId = z.string().trim().min(1).max(64);

export const SATISFIED_BY_TYPES = [
  "RESOLUTION",
  "MEMBER_REPORT",
  "DOCUMENT",
  "MANUAL",
] as const;
export type SatisfiedByType = (typeof SATISFIED_BY_TYPES)[number];

export const ZComplianceListSchema = z
  .object({ includeClosed: z.boolean().optional() })
  .strict();

export const ZComplianceCreateCustomSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    dueOn: ZDateOnly.optional(),
    templateKey: z.enum(CUSTOM_DEADLINE_TEMPLATE_KEYS).optional(),
    triggerOn: ZDateOnly.optional(),
    section: z.string().trim().max(50).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

export const ZComplianceUpdateSchema = z
  .object({
    id: zId,
    title: z.string().trim().min(1).max(200).optional(),
    dueOn: ZDateOnly.optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

export const ZComplianceCompleteSchema = z
  .object({
    id: zId,
    satisfiedByType: z.enum(SATISFIED_BY_TYPES),
    satisfiedByPublicId: zPublicId.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const ZComplianceReopenSchema = z.object({ id: zId }).strict();

export const ZComplianceMarkNotApplicableSchema = z
  .object({
    id: zId,
    note: z.string().trim().min(1).max(1000),
  })
  .strict();
