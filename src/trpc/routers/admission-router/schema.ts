import { z } from "zod";
import { W9_CONTENT_TYPES, W9_MAX_BYTES } from "@/server/llc/admission";

// Inputs of the admission router (01-foundation.md F12).

const ZPublicId = z.string().min(1).max(64);

export const ZodCreateMasterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bucketId: z.string().min(1).max(64),
});

export const ZodPacketPublicIdSchema = z.object({ publicId: ZPublicId });

export const ZodSendSubscriptionSchema = z
  .object({
    masterPublicId: ZPublicId,
    stakeholderId: z.string().min(1).max(64).optional(),
    prospect: z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().toLowerCase().email().max(254),
      })
      .optional(),
    managerMemberId: z.string().min(1).max(64),
    message: z.string().max(2000).optional(),
  })
  .refine(
    (v) => (v.stakeholderId === undefined) !== (v.prospect === undefined),
    {
      message: "Choose an existing person or enter a new one, not both.",
    },
  );

/** A W-9 link token (a JWT); bounded so a huge string is refused before it is verified. */
const ZW9Token = z.string().min(20).max(2048);

export const ZodW9InfoSchema = z.object({ token: ZW9Token });

export const ZodW9UploadUrlSchema = z.object({
  token: ZW9Token,
  // Accepted for the client's convenience; never stored, logged or put in the key.
  fileName: z.string().min(1).max(200),
  contentType: z.enum(W9_CONTENT_TYPES),
  size: z.number().int().min(1).max(W9_MAX_BYTES),
});

export const ZodW9CompleteSchema = z.object({
  token: ZW9Token,
  key: z.string().min(1).max(512),
});
