import { z } from "zod";

// Inputs of the public member-report router (03-governance.md G12).
// Client-safe: zod only, so the public report page (G13) may import these.
//
// Everything here is attacker-controlled. Objects are strict, every string is
// bounded, and the token is the ONLY identifier of the recipient: no report,
// recipient, stakeholder or company id is ever taken from the client (an
// attachment id is accepted only to pick one of the files the token's own
// recipient may see). Messages never echo the input.

const INVALID_LINK = "Invalid link.";

export const zReportToken = z
  .string({ error: INVALID_LINK })
  .min(20, INVALID_LINK)
  .max(2048, INVALID_LINK);

export const ZReportTokenSchema = z.object({ token: zReportToken }).strict();

export const ZReportAttachmentUrlSchema = z
  .object({
    token: zReportToken,
    attachmentId: z.string().min(1).max(64),
  })
  .strict();
