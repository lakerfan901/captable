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

const zSignature = z
  .object({
    signerName: z.string().trim().min(2).max(200),
    signerCapacity: z.string().trim().min(2).max(200),
  })
  .strict();

export const ZResolutionSendSchema = z
  .object({
    publicId: zPublicId,
    recordDate: zIsoDate,
    // Ignored for fixed-window (TERM_EXTENSION) and no-ballot (PURCHASE_ORDER) types.
    closesOn: zIsoDate.optional(),
    // Default: every eligible holder of the frozen register.
    recipientStakeholderIds: z
      .array(z.string().min(1).max(64))
      .max(500)
      .optional(),
    autoReminders: z.boolean().default(true),
    managerSignature: zSignature.optional(),
    commonMemberSignature: zSignature.optional(),
  })
  .strict();

export const ZResolutionApproveSchema = z
  .object({
    publicId: zPublicId,
    // The Manager signs at send (G7 send step 14); only the Common Member's
    // approval (12.1(d)) can be pending after send.
    role: z.literal("COMMON_MEMBER"),
    signerName: z.string().trim().min(2).max(200),
    signerCapacity: z.string().trim().min(2).max(200),
    bodyHash: z.string().trim().min(1).max(128),
  })
  .strict();

export const ZResolutionWithdrawSchema = z
  .object({
    publicId: zPublicId,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type TResolutionPreviewInput = z.infer<typeof ZResolutionPreviewSchema>;
export type TResolutionCreateInput = z.infer<typeof ZResolutionCreateSchema>;
export type TResolutionUpdateInput = z.infer<typeof ZResolutionUpdateSchema>;
export type TResolutionSendInput = z.input<typeof ZResolutionSendSchema>;
export type TResolutionApproveInput = z.infer<typeof ZResolutionApproveSchema>;
export type TResolutionWithdrawInput = z.infer<
  typeof ZResolutionWithdrawSchema
>;

// Ballot management (03-governance.md G8, session b).

const zId = z.string().trim().min(1).max(64);

export const ZResolutionAddRecipientsSchema = z
  .object({
    publicId: zPublicId,
    stakeholderIds: z.array(zId).min(1).max(500),
  })
  .strict();

export const ZResolutionRemindSchema = z
  .object({
    publicId: zPublicId,
    ballotIds: z.array(zId).min(1).max(500).optional(),
  })
  .strict();

export const ZResolutionReplaceBallotLinkSchema = z
  .object({
    publicId: zPublicId,
    ballotId: zId,
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();

export const ZResolutionRevokeBallotLinkSchema = z
  .object({ publicId: zPublicId, ballotId: zId })
  .strict();

export const ZResolutionEvidenceSchema = z
  .object({ publicId: zPublicId })
  .strict();

export type TResolutionAddRecipientsInput = z.infer<
  typeof ZResolutionAddRecipientsSchema
>;
export type TResolutionRemindInput = z.infer<typeof ZResolutionRemindSchema>;
export type TResolutionReplaceBallotLinkInput = z.infer<
  typeof ZResolutionReplaceBallotLinkSchema
>;
