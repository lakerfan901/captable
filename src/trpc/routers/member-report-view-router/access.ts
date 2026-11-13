// Pure decisions of the public member-report router (03-governance.md G12).
// No database, no `@/` imports: unit-tested by `access.test.ts`.
//
// `resolveRecipient` (procedures/resolve.ts) loads the rows and calls
// `classifyReportAccess`; every public procedure goes through it.

export type ReportAccess = "NOT_FOUND" | "REPLACED" | "OK";

export interface ReportAccessRow {
  /** Company of the report, loaded FROM THE ROW (never from the client). */
  companyEntityType: string;
  reportStatus: string;
  tokenVersion: number;
  tokenRevokedAt: Date | null;
  tokenExpiresAt: Date;
}

/**
 * G12 token validation, steps 4–6, in the plan's order (mirrors G8). Steps
 * 1–3 (input schema, signature + `exp` + strict `p: "mr"` payload, row
 * exists) happen before.
 *
 * 4. not an LLC, or the report is not SENT -> NOT_FOUND
 * 5. link revoked, or the token's version is not the row's current version
 *    -> REPLACED (the page shows the company name and logo only)
 * 6. the row's own expiry has passed -> NOT_FOUND
 */
export function classifyReportAccess(
  row: ReportAccessRow,
  tokenVersion: number,
  now: Date,
): ReportAccess {
  if (row.companyEntityType !== "LLC") return "NOT_FOUND";
  if (row.reportStatus !== "SENT") return "NOT_FOUND";
  if (row.tokenRevokedAt !== null || tokenVersion !== row.tokenVersion) {
    return "REPLACED";
  }
  if (row.tokenExpiresAt.getTime() <= now.getTime()) return "NOT_FOUND";
  return "OK";
}

/**
 * The attachments a recipient may see: shared files (no holder) and the
 * files private to that recipient's holder. On a TAX_K1 report only the
 * holder's own files (R22a: a Financial-Interest-only holder receives its
 * own K-1 and nothing else; `addAttachment` already refuses shared files
 * there, this is the second line of defence).
 */
export function isAttachmentVisible(
  attachment: { stakeholderId: string | null },
  recipientStakeholderId: string,
  reportType: string,
): boolean {
  if (attachment.stakeholderId === null) return reportType !== "TAX_K1";
  return attachment.stakeholderId === recipientStakeholderId;
}

/** Prisma `where` fragment equivalent to `isAttachmentVisible`. */
export function visibleAttachmentWhere(
  recipientStakeholderId: string,
  reportType: string,
):
  | { stakeholderId: string }
  | { OR: ({ stakeholderId: null } | { stakeholderId: string })[] } {
  if (reportType === "TAX_K1") return { stakeholderId: recipientStakeholderId };
  return {
    OR: [{ stakeholderId: null }, { stakeholderId: recipientStakeholderId }],
  };
}
