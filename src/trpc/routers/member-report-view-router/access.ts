// Pure decisions of the public member-report router (03-governance.md G12;
// 04-investor-portal.md P25, P26). No database, no `@/` imports (vitest has
// no alias): unit-tested by `access.test.ts`.
//
// `resolveRecipient` (procedures/resolve.ts) loads the rows and calls
// `classifyReportAccess`; every public procedure goes through it.

import {
  type AddresseeAccess,
  reportLinkState,
} from "../../../lib/portal/report-link-core";

/**
 * - NOT_FOUND: invalid, foreign, expired token; not an LLC; not SENT.
 * - REPLACED: the link was revoked or replaced (company name and logo only).
 * - OK: the read-only token page as today (P25 "LEGACY"): the report was
 *   sent before the portal, or it is published and the addressee was never
 *   invited at this address. The ONLY result that returns report content.
 * - WITHDRAWN: the report was unpublished ("no longer available").
 * - PORTAL: published, and the addressee has an ACTIVE access to this
 *   holder: the report is opened in the portal after sign-in.
 * - ACCESS_OFF: published, and the addressee's access was disabled.
 */
export type ReportAccess =
  | "NOT_FOUND"
  | "REPLACED"
  | "OK"
  | "WITHDRAWN"
  | "PORTAL"
  | "ACCESS_OFF";

export interface ReportAccessRow {
  /** Company of the report, loaded FROM THE ROW (never from the client). */
  companyEntityType: string;
  reportStatus: string;
  tokenVersion: number;
  tokenRevokedAt: Date | null;
  tokenExpiresAt: Date;
  /** Null: released before the investor portal existed (never published). */
  publishedAt: Date | null;
  /** Set: unpublished (P24). */
  unpublishedAt: Date | null;
  /**
   * The addressee's access to the recipient's holder, derived on the server
   * from the recipient row (`addresseeAccess` of report-link-core), never
   * from anything the visitor sends.
   */
  addresseeAccess: AddresseeAccess;
}

export interface ReportAccessResult {
  access: ReportAccess;
  /** PORTAL only: the addressee has not set a password yet. */
  setupNeeded: boolean;
}

/**
 * G12 token validation, steps 4–6, in the plan's order (mirrors G8), then
 * the P25 table. Steps 1–3 (input schema, signature + `exp` + strict
 * `p: "mr"` payload, row exists) happen before.
 *
 * 4. not an LLC, or the report is not SENT -> NOT_FOUND
 * 5. link revoked, or the token's version is not the row's current version
 *    -> REPLACED (the page shows the company name and logo only)
 * 6. the row's own expiry has passed -> NOT_FOUND
 * 7. P25 (`reportLinkState`): unpublished -> WITHDRAWN; never published ->
 *    OK; published -> PORTAL (ACTIVE or INVITED addressee), ACCESS_OFF
 *    (DISABLED) or OK (never invited at this address).
 *
 * The token checks come first: a replaced link of an unpublished report is
 * REPLACED (the P25 row "any report, token revoked or replaced").
 */
export function classifyReportAccess(
  row: ReportAccessRow,
  tokenVersion: number,
  now: Date,
): ReportAccessResult {
  const closed = (access: ReportAccess): ReportAccessResult => ({
    access,
    setupNeeded: false,
  });
  if (row.companyEntityType !== "LLC") return closed("NOT_FOUND");
  if (row.reportStatus !== "SENT") return closed("NOT_FOUND");
  if (row.tokenRevokedAt !== null || tokenVersion !== row.tokenVersion) {
    return closed("REPLACED");
  }
  if (row.tokenExpiresAt.getTime() <= now.getTime()) {
    return closed("NOT_FOUND");
  }
  const link = reportLinkState({
    publishedAt: row.publishedAt,
    unpublishedAt: row.unpublishedAt,
    addresseeAccess: row.addresseeAccess,
  });
  switch (link.state) {
    case "LEGACY":
      return closed("OK");
    case "WITHDRAWN":
      return closed("WITHDRAWN");
    case "PORTAL":
      return { access: "PORTAL", setupNeeded: link.setupNeeded };
    default:
      return closed("ACCESS_OFF");
  }
}

/** Where the sign-in and the set-up link lead for a report (P26: by public id, never by token). */
export function reportLandingPath(reportPublicId: string): string {
  return `/portal/go/report/${reportPublicId}`;
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
