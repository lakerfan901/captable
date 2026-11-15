// What an emailed report link (`/member-reports/{token}`) opens
// (04-investor-portal.md P25, P26, S15; package P1). Pure: no database, no
// `@/` imports.
//
// Runs after `classifyReportAccess` (member-report-view-router/access.ts)
// returned OK for the token, so the token, the report status and the company
// are already checked; the last row of the P25 table ("token invalid,
// expired, revoked or replaced") is decided there.

import { normalizePortalEmail } from "./visibility-core";

/**
 * The addressee's access to the recipient's holder: the `PortalAccess` for
 * this holder whose portal user's email equals `MemberReportRecipient.email`.
 * - NONE: never invited at this address.
 * - INVITED: ACTIVE, password not yet set.
 * - ACTIVE: ACTIVE, password set.
 * - DISABLED: the team turned it off.
 */
export type AddresseeAccess = "NONE" | "INVITED" | "ACTIVE" | "DISABLED";

export type ReportLinkState = "LEGACY" | "WITHDRAWN" | "PORTAL" | "ACCESS_OFF";

export interface ReportLinkInput {
  publishedAt: Date | null;
  unpublishedAt: Date | null;
  addresseeAccess: AddresseeAccess;
}

export interface ReportLinkResult {
  state: ReportLinkState;
  /** PORTAL only: the addressee has not set a password yet ("Email me my set-up link"). */
  setupNeeded: boolean;
}

/**
 * The P25 table, top to bottom:
 *
 * | report              | addressee access | state      | setupNeeded |
 * |---------------------|------------------|------------|-------------|
 * | unpublishedAt set   | any              | WITHDRAWN  | false       |
 * | publishedAt null    | any              | LEGACY     | false       |
 * | published           | ACTIVE           | PORTAL     | false       |
 * | published           | INVITED          | PORTAL     | true        |
 * | published           | DISABLED         | ACCESS_OFF | false       |
 * | published           | NONE             | LEGACY     | false       |
 *
 * `unpublishedAt` is checked first, so the inconsistent row (never published
 * but `unpublishedAt` set) is WITHDRAWN. LEGACY is the only state whose page
 * shows report content (P26), so it is reached only through the two explicit
 * branches; an unknown access value is ACCESS_OFF, never LEGACY.
 */
export function reportLinkState(input: ReportLinkInput): ReportLinkResult {
  if (input.unpublishedAt !== null) {
    return { state: "WITHDRAWN", setupNeeded: false };
  }
  if (input.publishedAt === null)
    return { state: "LEGACY", setupNeeded: false };
  switch (input.addresseeAccess) {
    case "ACTIVE":
      return { state: "PORTAL", setupNeeded: false };
    case "INVITED":
      return { state: "PORTAL", setupNeeded: true };
    case "NONE":
      return { state: "LEGACY", setupNeeded: false };
    default:
      return { state: "ACCESS_OFF", setupNeeded: false };
  }
}

/** P26: only the read-only token page (LEGACY) returns report content. */
export function linkShowsContent(state: ReportLinkState): boolean {
  return state === "LEGACY";
}

export interface HolderAccessRow {
  /** The portal user's email (stored lower-cased; normalised again here). */
  email: string;
  status: "ACTIVE" | "DISABLED";
  passwordSet: boolean;
}

/**
 * P25: pick the addressee's access among the accesses OF THE RECIPIENT'S
 * HOLDER (the caller loads them by `{ companyId, stakeholderId }`). Matching
 * the two addresses only chooses the page; it grants nothing (P1). Another
 * person's access to the same holder (an accountant) does not count. A
 * recipient address that does not normalise matches nothing. If two rows
 * ever match (they cannot: one access per portal user and holder, one portal
 * user per email), DISABLED wins.
 */
export function addresseeAccess(
  accesses: readonly HolderAccessRow[],
  recipientEmail: string | null,
): AddresseeAccess {
  const target = normalizePortalEmail(recipientEmail);
  if (target === null) return "NONE";
  let result: AddresseeAccess = "NONE";
  for (const access of accesses) {
    if (normalizePortalEmail(access.email) !== target) continue;
    if (access.status !== "ACTIVE") return "DISABLED";
    const state: AddresseeAccess =
      access.passwordSet === true ? "ACTIVE" : "INVITED";
    if (result === "NONE" || state === "INVITED") result = state;
  }
  return result;
}
