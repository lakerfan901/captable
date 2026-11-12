import { z } from "zod";

export const ZEmailLogStatus = z.enum(["SENT", "FAILED"]);
export const ZEmailBounceState = z.enum(["NONE", "BOUNCED", "COMPLAINED"]);

export const ZodListEmailLogSchema = z.object({
  stakeholderId: z.string().min(1).optional(),
  status: ZEmailLogStatus.optional(),
  cursor: z.string().min(1).optional(),
  take: z.number().int().min(1).max(100).default(50),
});

export const ZodMarkBounceSchema = z.object({
  id: z.string().min(1),
  bounceState: ZEmailBounceState,
  note: z.string().trim().max(500).optional(),
});

export const ZodSendTestEmailSchema = z.object({
  to: z.string().email(),
});

export type EmailLogDTO = {
  id: string;
  toAddress: string;
  subject: string;
  kind: string;
  status: z.infer<typeof ZEmailLogStatus>;
  sentAt: string | null;
  createdAt: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  bounceState: z.infer<typeof ZEmailBounceState>;
  bouncedAt: string | null;
  bounceNote: string | null;
  stakeholderId: string | null;
  stakeholderName: string | null;
  relatedType: string | null;
  relatedId: string | null;
};
