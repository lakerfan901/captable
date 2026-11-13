import { z } from "zod";
import {
  zId,
  zIsoDate,
  zMemo,
  zPositiveCents,
} from "@/trpc/routers/llc-shared/schema";

export const ZCallNoticeIdSchema = z.object({ id: zId });

export const ZSaveDraftSchema = z.object({
  id: zId.optional(),
  purpose: zMemo.optional(),
  bankAccountId: zId,
  lines: z
    .array(
      z.object({
        commitmentId: zId,
        amountCalledCents: zPositiveCents,
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (lines) =>
        new Set(lines.map((l) => l.commitmentId)).size === lines.length,
      { message: "Each commitment can appear only once." },
    ),
});
export type TSaveDraft = z.infer<typeof ZSaveDraftSchema>;

export const ZCancelDraftSchema = z.object({
  id: zId,
  reason: z.string().trim().min(1).max(500),
});

export const ZPreviewSchema = z.object({ id: zId, commitmentId: zId });

export const ZSendSchema = z.object({
  id: zId,
  expectedDueOn: zIsoDate,
  lineIds: z.array(zId).min(1).max(200).optional(),
});
export type TSend = z.infer<typeof ZSendSchema>;

export const ZCreateOutsideDateNoticeSchema = z.object({
  confirm: z.literal(true),
});

export const ZReconcileSchema = z.object({ commitmentId: zId.optional() });

export const ZResolveSendingSchema = z
  .object({
    lineId: zId,
    action: z.enum(["RESOLVE", "MARK_SENT", "MARK_NOT_SENT"]),
    /** Required for MARK_SENT: the date the notice was in fact sent. */
    sentOn: zIsoDate.optional(),
  })
  .refine((v) => v.action !== "MARK_SENT" || v.sentOn !== undefined, {
    message: "Enter the date the notice was sent.",
    path: ["sentOn"],
  });
export type TResolveSending = z.infer<typeof ZResolveSendingSchema>;

export const ZRecordPaymentSchema = z.object({
  commitmentId: zId,
  receivedOn: zIsoDate,
  amountCents: zPositiveCents,
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});
export type TRecordPayment = z.infer<typeof ZRecordPaymentSchema>;
