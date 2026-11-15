// View logic of the team's report release screens (04-investor-portal.md
// 6.2, P18–P27; package P4c): the release dialog, "Add recipients", the
// report page's "Investor portal" panel and recipient table, and the report
// list's status chip. Pure: no React, no `@/` imports, structural types only
// (tested by vitest without the alias). Every count of emails shown to the
// Manager user is computed here with the same rules the server applies
// (`audienceProblems`, `deadlineOutcome`, `resendPlan`, `inviteTargets`).

import {
  type AudienceWarning,
  audienceProblems,
  deadlineOutcome,
  type HolderPortalState,
  type ReportType,
} from "../portal/audience-core";
import { inviteTargets, type ResendScope, resendPlan } from "./recipient-core";

// ---------------------------------------------------------------------------
// The holders of the picker (`memberReport.audienceOptions`)

export type NoticeAddressAccess = "NONE" | "ACTIVE" | "DISABLED";

export interface PickerHolder {
  stakeholderId: string;
  name: string;
  memberStatus: "PROSPECT" | "MEMBER" | "FINANCIAL_INTEREST_ONLY";
  preferredUnits: string;
  commonUnits: string;
  /** "" when the holder has no notice address. */
  noticeEmail: string;
  hasK1: boolean;
  isRecipient: boolean;
  portal: HolderPortalState;
  /** The notice address's own access to this holder (P27). */
  noticeAddressAccess: NoticeAddressAccess;
  transferor: boolean;
}

export type PickerMode = "RELEASE" | "ADD";

/**
 * The holders listed in the picker. A TAX_K1 report lists only holders with
 * a K-1 attached (the server refuses any other, P18); "Add recipients" lists
 * only holders that are not yet recipients.
 */
export function pickerCandidates<T extends PickerHolder>(
  type: ReportType,
  holders: readonly T[],
  mode: PickerMode,
): T[] {
  return holders.filter(
    (h) =>
      (type !== "TAX_K1" || h.hasK1) && (mode === "RELEASE" || !h.isRecipient),
  );
}

/**
 * The ticks the picker opens with. Release: the default preset (P18).
 * Add recipients: on a TAX_K1 report every listed holder (P21: "K-1
 * attached, not yet a recipient", pre-ticked); otherwise none.
 */
export function initialSelection(
  type: ReportType,
  mode: PickerMode,
  candidates: readonly { stakeholderId: string }[],
  presets: readonly { key: string; stakeholderIds: readonly string[] }[],
  defaultPreset: string | null,
): Set<string> {
  const listed = new Set(candidates.map((c) => c.stakeholderId));
  if (mode === "ADD") {
    return type === "TAX_K1" ? listed : new Set();
  }
  const preset = presets.find((p) => p.key === defaultPreset);
  return new Set((preset?.stakeholderIds ?? []).filter((id) => listed.has(id)));
}

/** A preset button: exactly the listed holders of that preset ("Clear": none). */
export function applyPreset(
  candidates: readonly { stakeholderId: string }[],
  presetIds: readonly string[] | null,
): Set<string> {
  if (presetIds === null) return new Set();
  const listed = new Set(candidates.map((c) => c.stakeholderId));
  return new Set(presetIds.filter((id) => listed.has(id)));
}

/** The search box: name or notice address, case-insensitive. */
export function filterHolders<T extends { name: string; noticeEmail: string }>(
  holders: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...holders];
  return holders.filter(
    (h) =>
      h.name.toLowerCase().includes(q) ||
      h.noticeEmail.toLowerCase().includes(q),
  );
}

/** "Preferred 1,000 · Common 50", "No units". */
export function unitsText(h: {
  preferredUnits: string;
  commonUnits: string;
}): string {
  const parts: string[] = [];
  const fmt = (v: string) => {
    const [int = "0", frac = ""] = v.split(".");
    const trimmed = frac.replace(/0+$/, "");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return trimmed ? `${grouped}.${trimmed}` : grouped;
  };
  const nonZero = (v: string) => /[1-9]/.test(v);
  if (nonZero(h.preferredUnits))
    parts.push(`Preferred ${fmt(h.preferredUnits)}`);
  if (nonZero(h.commonUnits)) parts.push(`Common ${fmt(h.commonUnits)}`);
  return parts.length > 0 ? parts.join(" · ") : "No units";
}

export const PORTAL_STATE_LABEL: Readonly<Record<HolderPortalState, string>> = {
  NONE: "No access",
  INVITED: "Invited",
  ACTIVE: "Active",
};

export const MEMBER_STATUS_NOTE: Readonly<Record<string, string>> = {
  FINANCIAL_INTEREST_ONLY: "Financial Interest only",
  PROSPECT: "Prospect",
};

// ---------------------------------------------------------------------------
// The release and "Add recipients" dialogs

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * P27: the selected holders whose notice address has no access to them,
 * listed under "Invite these … to the portal". Holders without a usable
 * notice address are not listed (nobody to invite); a DISABLED access is
 * left disabled by the server and is not listed either.
 */
export function holdersToInvite<T extends PickerHolder>(
  selected: readonly T[],
): T[] {
  const { targets } = inviteTargets(
    selected
      .filter((h) => h.noticeAddressAccess === "NONE")
      .map((h) => ({
        stakeholderId: h.stakeholderId,
        name: h.name,
        noticeEmail: h.noticeEmail,
      })),
  );
  const ok = new Set(targets.map((t) => t.stakeholderId));
  return selected.filter((h) => ok.has(h.stakeholderId));
}

/** One invitation email per person (address), as the server queues them. */
export function invitationEmailCount(
  invited: readonly {
    stakeholderId: string;
    name: string;
    noticeEmail: string;
  }[],
): number {
  const { targets } = inviteTargets(invited);
  return new Set(targets.map((t) => t.email)).size;
}

export interface DeliveryInput {
  /** "Also send by email" ticked (and allowed). */
  email: boolean;
  /** The invitation line is shown and ticked (needs `portal: create`). */
  invite: boolean;
}

export interface DeliveryPlan {
  /** Report emails sent now: one per selected holder. */
  reportEmails: number;
  /** Portal invitation emails sent now: one per person. */
  invitationEmails: number;
  /** The holders listed under the invitation line ([] when not shown). */
  inviteLine: PickerHolder[];
  /** Send `inviteMissing: true`. */
  inviteMissing: boolean;
}

/**
 * What a release or an addition sends. The invitation line exists only
 * when email is ticked, the role may invite, and a selected holder's notice
 * address has no access to it.
 */
export function deliveryPlan(
  selected: readonly PickerHolder[],
  input: DeliveryInput & { mayInvite: boolean },
): DeliveryPlan {
  const inviteLine =
    input.email && input.mayInvite ? holdersToInvite(selected) : [];
  const inviteMissing = input.invite && inviteLine.length > 0;
  return {
    reportEmails: input.email ? selected.length : 0,
    invitationEmails: inviteMissing ? invitationEmailCount(inviteLine) : 0,
    inviteLine,
    inviteMissing,
  };
}

/** "4 report emails and 2 portal invitations" / null when nothing is emailed. */
export function emailsSentence(plan: {
  reportEmails: number;
  invitationEmails: number;
}): string | null {
  const parts: string[] = [];
  if (plan.reportEmails > 0) {
    parts.push(plural(plan.reportEmails, "report email", "report emails"));
  }
  if (plan.invitationEmails > 0) {
    parts.push(
      plural(plan.invitationEmails, "portal invitation", "portal invitations"),
    );
  }
  return parts.length > 0 ? parts.join(" and ") : null;
}

export function totalEmails(plan: {
  reportEmails: number;
  invitationEmails: number;
}): number {
  return plan.reportEmails + plan.invitationEmails;
}

/** The release dialog's confirm button. */
export function releaseButtonLabel(holders: number, emails: number): string {
  const base = `Release to ${plural(holders, "holder", "holders")}`;
  return emails > 0
    ? `${base} and send ${plural(emails, "email", "emails")}`
    : base;
}

/** The "Add recipients" dialog's confirm button. */
export function addButtonLabel(holders: number, emails: number): string {
  const base = `Add ${plural(holders, "recipient", "recipients")}`;
  return emails > 0
    ? `${base} and send ${plural(emails, "email", "emails")}`
    : base;
}

export interface ReleaseFacts {
  type: ReportType;
  noticeKind: string | null;
  /** YYYY-MM-DD; the books are closed through it (QUARTERLY / ANNUAL). */
  periodEnd: string | null;
  /** The report carries a compliance deadline (its due date, or a K-1 year). */
  hasDeadline: boolean;
}

export interface ReleaseAudienceInput {
  holders: readonly PickerHolder[];
  selectedIds: readonly string[];
  email: boolean;
  /** `audienceOptions.deadlineAudienceIds`. */
  deadlineAudienceIds: readonly string[];
  formatDate: (ymd: string) => string;
}

/**
 * The warnings under the picker and the "Consequences" list of the release
 * dialog (6.2). Warnings are `audienceProblems`' (the departures from the
 * default audience), except RECEIVES_NOTHING, which is a consequence.
 */
export function releaseReview(
  facts: ReleaseFacts,
  input: ReleaseAudienceInput,
): {
  warnings: AudienceWarning[];
  consequences: string[];
  /** Refusals the server would answer with (shown, and the button is off). */
  problems: string[];
} {
  const transferorId =
    input.holders.find((h) => h.transferor)?.stakeholderId ?? null;
  const checked = audienceProblems(
    facts.type,
    input.selectedIds,
    input.holders,
    { noticeKind: facts.noticeKind, transferorId, email: input.email },
  );
  const warnings = checked.warnings.filter(
    (w) => w.code !== "RECEIVES_NOTHING",
  );
  const consequences: string[] = [];
  if (
    (facts.type === "QUARTERLY" || facts.type === "ANNUAL") &&
    facts.periodEnd !== null
  ) {
    consequences.push(
      `Books closed through ${input.formatDate(facts.periodEnd)}: ledger entries dated on or before that day can no longer be changed.`,
    );
  }
  if (facts.hasDeadline) {
    consequences.push(
      deadlineOutcome(
        facts.type,
        input.email,
        input.selectedIds,
        input.deadlineAudienceIds,
      ).sentence,
    );
  }
  const nothing = checked.warnings.find((w) => w.code === "RECEIVES_NOTHING");
  if (nothing) consequences.push(nothing.message);
  consequences.push(
    "The content is frozen. Holders not selected never see this report.",
  );
  return {
    warnings,
    consequences,
    problems: problemTexts(checked.refusals, input.holders),
  };
}

/** The checks of `addRecipients`, for the "Add recipients" dialog. */
export function addReview(
  facts: Pick<ReleaseFacts, "type" | "noticeKind">,
  input: Omit<ReleaseAudienceInput, "deadlineAudienceIds" | "formatDate">,
): { warnings: AudienceWarning[]; consequences: string[]; problems: string[] } {
  const transferorId =
    input.holders.find((h) => h.transferor)?.stakeholderId ?? null;
  const checked = audienceProblems(
    facts.type,
    input.selectedIds,
    input.holders,
    {
      noticeKind: facts.noticeKind,
      transferorId,
      email: input.email,
    },
  );
  const selection = new Set([
    "TRANSFEROR_SELECTED",
    "NOT_MEMBERS_SELECTED",
    "OUTSIDE_DEFAULT_SELECTED",
  ]);
  const warnings = checked.warnings.filter((w) => selection.has(w.code));
  const consequences: string[] = [];
  const nothing = checked.warnings.find((w) => w.code === "RECEIVES_NOTHING");
  if (nothing) consequences.push(nothing.message);
  consequences.push(
    "The holders you add see the same frozen content. Adding recipients closes no compliance deadline.",
  );
  return {
    warnings,
    consequences,
    problems: problemTexts(checked.refusals, input.holders),
  };
}

function problemTexts(
  refusals: readonly {
    code: string;
    stakeholderId?: string;
    message: string;
  }[],
  holders: readonly { stakeholderId: string; name: string }[],
): string[] {
  const name = new Map(holders.map((h) => [h.stakeholderId, h.name]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of refusals) {
    if (r.code === "EMPTY") continue; // the button says "Select …"
    let text = r.message;
    if (r.code === "NO_NOTICE_ADDRESS" && r.stakeholderId) {
      text = `${name.get(r.stakeholderId) ?? "A holder"} has no notice email: untick "Also send by email" or the holder.`;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report page

export interface PublishFacts {
  status: string;
  publishedAt: Date | string | null;
  unpublishedAt: Date | string | null;
}

/** P24: the panel's state. NEVER: released before the portal existed. */
export type PublishState = "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | "NEVER";

export function publishState(r: PublishFacts): PublishState {
  if (r.status !== "SENT") return "DRAFT";
  if (r.unpublishedAt !== null) return "UNPUBLISHED";
  if (r.publishedAt === null) return "NEVER";
  return "PUBLISHED";
}

/** The status chip of the report list and page (6.2): Draft, Released, Unpublished. */
export function reportChip(r: PublishFacts): {
  label: "Draft" | "Released" | "Unpublished";
  variant: "warning" | "success" | "secondary";
} {
  if (r.status !== "SENT") return { label: "Draft", variant: "warning" };
  if (r.unpublishedAt !== null)
    return { label: "Unpublished", variant: "secondary" };
  return { label: "Released", variant: "success" };
}

/** The header line next to the chip: "Released {date} · emailed to 2 of 3". */
export function releasedLine(
  releasedAt: string,
  emailed: number,
  recipients: number,
): string {
  return `Released ${releasedAt} · ${
    emailed > 0 ? `emailed to ${emailed} of ${recipients}` : "not emailed"
  }`;
}

/** Emailing after release is refused only while the report is unpublished (P24). */
export function mayEmail(state: PublishState): boolean {
  return state === "PUBLISHED" || state === "NEVER";
}

export interface RecipientFacts {
  id: string;
  name: string;
  /** "" when the recipient has no address. */
  email: string;
  sendCount: number;
  emailedAt: Date | string | null;
  linkState: "ACTIVE" | "EXPIRED" | "REVOKED";
  canRemove: boolean;
}

function asResendRow(r: RecipientFacts) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    sendCount: r.sendCount,
    sentAt: r.emailedAt === null ? null : new Date(r.emailedAt),
    // `get` reports a revoked link through `linkState`.
    tokenRevokedAt: r.linkState === "REVOKED" ? new Date(0) : null,
  };
}

/** The row actions of a recipient (6.2), each absent when not allowed. */
export function recipientActions(
  r: RecipientFacts,
  ctx: { canUpdate: boolean; state: PublishState },
): {
  /** "Email" (never emailed) or "Resend"; null: not offered. */
  email: "Email" | "Resend" | null;
  replaceLink: boolean;
  remove: boolean;
} {
  if (!ctx.canUpdate || ctx.state === "DRAFT") {
    return { email: null, replaceLink: false, remove: false };
  }
  const emailing = mayEmail(ctx.state);
  const plan = resendPlan([asResendRow(r)], "ALL");
  return {
    email:
      emailing && plan.queue.length === 1
        ? r.emailedAt === null
          ? "Email"
          : "Resend"
        : null,
    replaceLink: emailing,
    remove: r.canRemove,
  };
}

/** An email round of `resend` as the server will run it: who is emailed, who is skipped and why. */
export function resendRound(
  recipients: readonly RecipientFacts[],
  scope: ResendScope,
): {
  queued: number;
  skipped: { name: string; reason: "NO_ADDRESS" | "LINK_REVOKED" }[];
} {
  const plan = resendPlan(recipients.map(asResendRow), scope);
  return {
    queued: plan.queue.length,
    skipped: plan.skipped.map((s) => ({ name: s.row.name, reason: s.reason })),
  };
}

/**
 * `replaceLink`: the new link to the (new) address, plus, when the address
 * changes, one notice without a link to the previous address and to the
 * holder's notice address on file (each once, never to the new address).
 */
export function replaceLinkEmailCount(input: {
  currentEmail: string;
  newEmail: string;
  noticeEmail: string | null;
}): { total: number; notices: number } {
  const next = input.newEmail.trim();
  // The same address (any case) is no change: the new link only.
  if (next === "" || next.toLowerCase() === input.currentEmail.toLowerCase()) {
    return { total: 1, notices: 0 };
  }
  const seen = new Set([next.toLowerCase()]);
  let notices = 0;
  for (const raw of [input.currentEmail, input.noticeEmail]) {
    const a = raw?.trim().toLowerCase();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    notices += 1;
  }
  return { total: 1 + notices, notices };
}
