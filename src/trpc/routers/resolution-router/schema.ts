import { z } from "zod";
import {
  RESOLUTION_TYPES,
  type ResolutionType,
} from "@/lib/governance/presets";
import { zIsoDate } from "@/trpc/routers/llc-shared/schema";

// Inputs of the resolution router (03-governance.md G7). Client-safe: zod and
// pure modules only, so the UI (G10/G11) may import these.

export const RESOLUTION_STATUSES = [
  "DRAFT",
  "SENT",
  "EFFECTIVE",
  "FAILED",
  "WITHDRAWN",
  "EXPIRED",
] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const ZResolutionType = z.enum(
  RESOLUTION_TYPES as unknown as [ResolutionType, ...ResolutionType[]],
);
export const ZResolutionStatus = z.enum(RESOLUTION_STATUSES);

const zPublicId = z.string().trim().min(1).max(64);

export const ZResolutionListSchema = z
  .object({ statuses: z.array(ZResolutionStatus).max(6).optional() })
  .strict();

export const ZResolutionGetSchema = z.object({ publicId: zPublicId }).strict();

export const ZResolutionOptionsSchema = z
  .object({
    types: z.array(ZResolutionType).max(9).optional(),
    statuses: z.array(ZResolutionStatus).max(6).default(["EFFECTIVE"]),
  })
  .strict();

export const ZResolutionPreviewSchema = z
  .object({
    type: ZResolutionType,
    params: z.unknown(),
    recordDate: zIsoDate,
  })
  .strict();

export const ZResolutionCreateSchema = z
  .object({ type: ZResolutionType, params: z.unknown() })
  .strict();

export const ZResolutionUpdateSchema = z
  .object({
    publicId: zPublicId,
    title: z.string().trim().min(1).max(200),
    params: z.unknown(),
    body: z.unknown(),
  })
  .strict();

export const ZResolutionDeleteSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZResolutionCloneSchema = z
  .object({ publicId: zPublicId })
  .strict();

export type TResolutionPreviewInput = z.infer<typeof ZResolutionPreviewSchema>;
export type TResolutionCreateInput = z.infer<typeof ZResolutionCreateSchema>;
export type TResolutionUpdateInput = z.infer<typeof ZResolutionUpdateSchema>;
