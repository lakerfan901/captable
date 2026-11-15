// Pure parts of the after-release procedures of member reports
// (04-investor-portal.md P19, P21, P24, P27, 5.5; package P4b): who may be
// removed, what "Add recipients" adds and refuses, which recipients an email
// round queues or skips, and which invitations of one release or addition
// are emailed. Relative imports only (tested without the `@/` alias).

import {
  type AudienceHolder,
  type AudienceOptions,
  type AudienceRefusal,
  type AudienceWarning,
  audienceProblems,
  type ReportType,
} from "../portal/audience-core";
import { normalizePortalEmail } from "../portal/visibility-core";

// ---------------------------------------------------------------------------
// Removing a recipient (P19, 5.5 `removeRecipient`)

export interface RemovableFacts {
  /** Claims taken by the email job (0: never claimed, so never emailed). */
  sendCount: number;
  /** First email accepted by the mail server. */
  sentAt: Date | null;
  /** First view through the emailed link (token page). */
  firstViewedAt: Date | null;
  viewCount: number;
  /** A `PortalAccessLog` row of this holder for this report or one of its files. */
  portalTouched: boolean;
}

/**
 * Why a recipient cannot be removed, or null when it can: it was never
 * emailed (no claim was ever taken, no email accepted), never opened
 * through the emailed link, and nothing of this report was opened in the
 * portal for this holder. Anything else is history the audit needs.
 */
export function removalRefusal(r: RemovableFacts): string | null {
  if (r.sendCount > 0 || r.sentAt !== null) {
    return "This recipient has been emailed the report and cannot be removed.";
  }
  if (r.firstViewedAt !== null || r.viewCount > 0) {
    return "This recipient has opened the report through the emailed link and cannot be removed.";
  }
  if (r.portalTouched) {
    return "This recipient has opened the report in the investor portal and cannot be removed.";
  }
  return null;
}

/** `memberReport.get`'s `canRemove`: the same rule as `removeRecipient`. */
export function canRemoveRecipient(r: RemovableFacts): boolean {
  return removalRefusal(r) === null;
}

// ---------------------------------------------------------------------------
// Adding recipients after release (P19, P21, 5.5 `addRecipients`)

export interface AddRecipientsPlan {
  /** Non-empty: refused, nothing is written. */
  refusals: AudienceRefusal[];
  /** Departures from the default audience that this addition leaves or adds; never block. */
  warnings: AudienceWarning[];
  /** The ids to add, in the order given (each once). */
  newIds: string[];
  /** Requested ids that already have a recipient row: left as they are. */
  alreadyRecipientIds: string[];
}

/** Warnings that name SELECTED holders: only the newly added ones are named. */
const SELECTION_WARNINGS = new Set<AudienceWarning["code"]>([
  "TRANSFEROR_SELECTED",
  "NOT_MEMBERS_SELECTED",
  "OUTSIDE_DEFAULT_SELECTED",
  "RECEIVES_NOTHING",
]);

/**
 * The checks of release (`audienceProblems`, P18) applied to the holders
 * being added, never to the existing rows (a recipient that has since
 * become ineligible stays what the Manager user confirmed then):
 *
 * - a list naming a holder twice is refused (DUPLICATE), as at release;
 * - ids that already have a row are not added again and not refused
 *   (a double click, or a second team member, adds once);
 * - the new ids are refused as at release: unknown or foreign id, prospect,
 *   other status, on a TAX_K1 report a holder without a K-1 attached, and,
 *   when emailing, a holder without a notice address.
 *
 * Warnings are computed on the whole audience after the addition: who of
 * the default audience is still left out, and which newly added holders are
 * unusual choices.
 */
export function planAddRecipients(
  reportType: ReportType,
  requestedIds: readonly string[],
  holders: readonly AudienceHolder[],
  existingIds: ReadonlySet<string>,
  options: AudienceOptions = {},
): AddRecipientsPlan {
  const refusals: AudienceRefusal[] = [];
  const seen = new Set<string>();
  const newIds: string[] = [];
  const alreadyRecipientIds: string[] = [];
  for (const id of requestedIds) {
    if (seen.has(id)) {
      refusals.push({
        code: "DUPLICATE",
        stakeholderId: id,
        message: "A holder is listed more than once.",
      });
      continue;
    }
    seen.add(id);
    if (existingIds.has(id)) alreadyRecipientIds.push(id);
    else newIds.push(id);
  }
  if (requestedIds.length === 0) {
    refusals.push({ code: "EMPTY", message: "Select at least one holder." });
  }
  const warnings: AudienceWarning[] = [];
  if (newIds.length === 0)
    return { refusals, warnings, newIds, alreadyRecipientIds };
  const added = audienceProblems(reportType, newIds, holders, options);
  refusals.push(...added.refusals);

  // Who of the default audience is still left out: on the whole audience
  // after the addition (existing rows of holders still on the register).
  const known = new Set(holders.map((h) => h.stakeholderId));
  const union = [...[...existingIds].filter((id) => known.has(id)), ...newIds];
  const whole = audienceProblems(reportType, union, holders, {
    ...options,
    email: false,
  });
  warnings.push(
    ...whole.warnings.filter((w) => !SELECTION_WARNINGS.has(w.code)),
  );
  // Unusual choices: only the holders being added are named.
  warnings.push(
    ...added.warnings.filter((w) => SELECTION_WARNINGS.has(w.code)),
  );
  return { refusals, warnings, newIds, alreadyRecipientIds };
}

// ---------------------------------------------------------------------------
// Email rounds after release (`resend`, P21; finding: blank addresses)

export type ResendScope = "ALL" | "NOT_EMAILED";

export interface ResendRow {
  id: string;
  name: string;
  /** The address the link goes to; "" for a portal-only recipient without a notice address. */
  email: string;
  sendCount: number;
  sentAt: Date | null;
  tokenRevokedAt: Date | null;
}

export type ResendSkipReason = "NO_ADDRESS" | "LINK_REVOKED";

export const RESEND_SKIP_TEXT: Readonly<Record<ResendSkipReason, string>> = {
  NO_ADDRESS: "no email address (replace the link with an address first)",
  LINK_REVOKED: "the link is revoked (replace the link first)",
};

function skipReason(row: ResendRow): ResendSkipReason | null {
  if (row.email.trim() === "") return "NO_ADDRESS";
  if (row.tokenRevokedAt !== null) return "LINK_REVOKED";
  return null;
}

/**
 * The recipients one email round queues, and those it cannot email. Nothing
 * without an address (or with a revoked link, which the job would not send)
 * is ever queued, so `queue.length` is what is really sent.
 * - ALL: every recipient (as `resend` always did).
 * - NOT_EMAILED: only recipients whose email was never accepted
 *   (`sentAt` null): "Email all not yet emailed" after a portal-only
 *   release or an addition without email.
 */
export function resendPlan(
  rows: readonly ResendRow[],
  scope: ResendScope,
): {
  queue: ResendRow[];
  skipped: { row: ResendRow; reason: ResendSkipReason }[];
} {
  const queue: ResendRow[] = [];
  const skipped: { row: ResendRow; reason: ResendSkipReason }[] = [];
  for (const row of rows) {
    if (scope === "NOT_EMAILED" && row.sentAt !== null) continue;
    const reason = skipReason(row);
    if (reason === null) queue.push(row);
    else skipped.push({ row, reason });
  }
  return { queue, skipped };
}

/** One named recipient ("Email this recipient"): the refusal, or null. */
export function singleResendRefusal(row: ResendRow): string | null {
  const reason = skipReason(row);
  if (reason === "NO_ADDRESS") {
    return `${row.name} has no email address. Replace the link with an address to email it.`;
  }
  if (reason === "LINK_REVOKED") {
    return `The link of ${row.name} is revoked. Replace the link to email it again.`;
  }
  return null;
}

/** Emailing after release is refused while the report is unpublished (P24). */
export const UNPUBLISHED_EMAIL_REFUSAL =
  "This report is unpublished. Publish it again before emailing it.";

// ---------------------------------------------------------------------------
// Invitations with a release or an addition (P27, `inviteMissing`)

export interface InviteCandidate {
  stakeholderId: string;
  name: string;
  /** `noticeEmail ?? email`, trimmed; "" when the holder has none. */
  noticeEmail: string;
}

export type InviteSkipReason = "NO_ADDRESS" | "INVALID_ADDRESS";

export interface InviteTarget {
  stakeholderId: string;
  name: string;
  /** The normalised address (`normalizePortalEmail`). */
  email: string;
}

/**
 * Which selected holders are invited at their notice address, in a fixed
 * order (address, then holder id): every invitation takes the portal user's
 * row lock, and one order for every caller means two releases (of two
 * companies) inviting the same people never wait on each other in a cycle.
 * Holders without a notice address, or with one that is not a valid portal
 * address, are not invited and are reported.
 */
export function inviteTargets(candidates: readonly InviteCandidate[]): {
  targets: InviteTarget[];
  skipped: { stakeholderId: string; name: string; reason: InviteSkipReason }[];
} {
  const targets: InviteTarget[] = [];
  const skipped: {
    stakeholderId: string;
    name: string;
    reason: InviteSkipReason;
  }[] = [];
  for (const c of candidates) {
    if (c.noticeEmail.trim() === "") {
      skipped.push({
        stakeholderId: c.stakeholderId,
        name: c.name,
        reason: "NO_ADDRESS",
      });
      continue;
    }
    const email = normalizePortalEmail(c.noticeEmail);
    if (email === null) {
      skipped.push({
        stakeholderId: c.stakeholderId,
        name: c.name,
        reason: "INVALID_ADDRESS",
      });
      continue;
    }
    targets.push({ stakeholderId: c.stakeholderId, name: c.name, email });
  }
  targets.sort((a, b) =>
    a.email < b.email
      ? -1
      : a.email > b.email
        ? 1
        : a.stakeholderId < b.stakeholderId
          ? -1
          : a.stakeholderId > b.stakeholderId
            ? 1
            : 0,
  );
  return { targets, skipped };
}

/**
 * One invitation email per person. Several selected holders can share a
 * notice address (one person, two trusts): each gets its access, but every
 * new set-password token retires the person's earlier ones, so only the
 * LAST invitation of that address carries a working link. Keeps, per
 * address, the last result that has an email to send.
 */
export function invitationEmailsToQueue<
  T extends { email: string; emailKind: string | null },
>(results: readonly T[]): T[] {
  const last = new Map<string, T>();
  for (const r of results) {
    if (r.emailKind === null) continue;
    last.set(r.email, r);
  }
  return [...last.values()];
}
