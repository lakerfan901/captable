import { z } from "zod";
import { NOTICE_KIND_KEYS } from "@/lib/governance/report-figures";

// Inputs of the Manager's member-report router (03-governance.md G12).
// Client-safe: zod and pure modules only, so the report UI (G13) may import
// these. Every object is strict and every string bounded. Figures and
// commentary are `unknown` here and validated by the procedures
// (`ReportFiguresSchema`, `normalizeBlocks`), after a size cap.

export const MEMBER_REPORT_TYPES = [
  "QUARTERLY",
  "ANNUAL",
  "TAX_K1",
  "NOTICE",
] as const;
export type MemberReportTypeValue = (typeof MEMBER_REPORT_TYPES)[number];

export const MEMBER_REPORT_ATTACHMENT_KINDS = [
  "GENERAL",
  "BALANCE_SHEET",
  "INCOME_STATEMENT",
  "K1",
] as const;
export type MemberReportAttachmentKind =
  (typeof MEMBER_REPORT_ATTACHMENT_KINDS)[number];

export const ZMemberReportType = z.enum(MEMBER_REPORT_TYPES);
export const ZNoticeKind = z.enum(NOTICE_KIND_KEYS);

const zPublicId = z.string().trim().min(1).max(64);
const zId = z.string().trim().min(1).max(64);

/** Raw JSON payloads (figures, BlockNote blocks) are capped before parsing. */
export const MAX_JSON_CHARS = 1_000_000;

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const zBoundedJson = z
  .unknown()
  .refine((v) => jsonSize(v) <= MAX_JSON_CHARS, "The content is too large.");

export const ZMemberReportListSchema = z
  .object({ type: ZMemberReportType.optional() })
  .strict();

export const ZMemberReportGetSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZMemberReportCreateSchema = z
  .object({
    type: ZMemberReportType,
    fiscalYear: z.number().int().min(2000).max(2100).optional(),
    fiscalQuarter: z.number().int().min(1).max(4).optional(),
    noticeKind: ZNoticeKind.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    relatedType: z.literal("COMPLIANCE_DEADLINE").optional(),
    relatedId: zId.optional(),
  })
  .strict();

export const ZMemberReportRefreshFiguresSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZMemberReportUpdateSchema = z
  .object({
    publicId: zPublicId,
    title: z.string().trim().min(1).max(200),
    /** ReportFigures (QUARTERLY / ANNUAL); ignored for TAX_K1 and NOTICE. */
    figures: zBoundedJson,
    /** BlockNote blocks. */
    commentary: zBoundedJson,
  })
  .strict();

export const ZMemberReportAddAttachmentSchema = z
  .object({
    publicId: zPublicId,
    bucketId: zId,
    name: z.string().trim().min(1).max(200),
    kind: z.enum(MEMBER_REPORT_ATTACHMENT_KINDS),
    stakeholderId: zId.optional(),
  })
  .strict();

export const ZMemberReportRemoveAttachmentSchema = z
  .object({ publicId: zPublicId, attachmentId: zId })
  .strict();

export const ZMemberReportAttachmentUrlSchema = z
  .object({ publicId: zPublicId, attachmentId: zId })
  .strict();

export const ZMemberReportDeleteSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZMemberReportSendSchema = z
  .object({ publicId: zPublicId })
  .strict();

export const ZMemberReportResendSchema = z
  .object({ publicId: zPublicId, recipientId: zId.optional() })
  .strict();

export const ZMemberReportReplaceLinkSchema = z
  .object({
    publicId: zPublicId,
    recipientId: zId,
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();
