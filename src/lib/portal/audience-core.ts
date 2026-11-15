// Report audience: presets, checks and deadline consequence
// (04-investor-portal.md P18–P22, S4, S5; package P1). Pure: no database, no
// `@/` imports.
//
// Release (P4) loads every holder of the company with its units, K-1 and
// notice address, calls these functions and stores exactly the confirmed
// list. The server refuses impossible choices (`refusals`); unusual but valid
// ones are warnings shown in the dialog (S5: every departure from the
// default audience is named).
//
// Ids are compared in Maps and Sets only, never as object keys, so ids such
// as "__proto__" or "constructor" behave like any other string.

import { TRANSFER_NOTICE_KINDS } from "../governance/report-figures";
import { toMicro } from "../llc/voting";

/** Mirrors `MemberReportTypeEnum`. */
export type ReportType = "QUARTERLY" | "ANNUAL" | "TAX_K1" | "NOTICE";

/** Mirrors the holder `memberStatus` values. */
export type HolderMemberStatus =
  | "PROSPECT"
  | "MEMBER"
  | "FINANCIAL_INTEREST_ONLY";

/** The holder's portal state as `memberReport.audienceOptions` reports it. */
export type HolderPortalState = "NONE" | "INVITED" | "ACTIVE";

/** P4 release input: `stakeholderIds (1–500)`. */
export const MAX_AUDIENCE = 500;

export interface AudienceHolder {
  stakeholderId: string;
  memberStatus: HolderMemberStatus;
  /** Units as decimal strings with up to 6 decimals ("0.000000" when none). */
  preferredUnits: string;
  commonUnits: string;
  /** A K-1 attachment of THIS report names this holder. */
  hasK1: boolean;
  /** `noticeEmail ?? email`, trimmed; "" or null when the holder has none. */
  noticeEmail?: string | null;
  /** Needed only for the RECEIVES_NOTHING warning. */
  portal?: HolderPortalState;
}

export type PresetKey =
  | "ALL_CURRENT_MEMBERS"
  | "PREFERRED_MEMBERS"
  | "COMMON_MEMBERS"
  | "OTHER_PREFERRED_MEMBERS"
  | "K1_ATTACHED";

export const PRESET_LABELS: Readonly<Record<PresetKey, string>> = {
  ALL_CURRENT_MEMBERS: "All current Members",
  PREFERRED_MEMBERS: "Preferred Members",
  COMMON_MEMBERS: "Common Members",
  OTHER_PREFERRED_MEMBERS: "Other Preferred Members",
  K1_ATTACHED: "Holders with a K-1 attached",
};

export interface AudiencePreset {
  key: PresetKey;
  label: string;
  stakeholderIds: string[];
}

export interface AudiencePresets {
  presets: AudiencePreset[];
  /** null when no default can be computed (a transfer notice without a transferor). */
  defaultPreset: PresetKey | null;
}

function preferredMicro(h: AudienceHolder): bigint {
  return toMicro(h.preferredUnits);
}

function commonMicro(h: AudienceHolder): bigint {
  return toMicro(h.commonUnits);
}

/** A current Member: `memberStatus MEMBER` with units > 0 (as `listCurrentMembers`). */
export function isCurrentMember(h: AudienceHolder): boolean {
  return h.memberStatus === "MEMBER" && preferredMicro(h) + commonMicro(h) > 0n;
}

/** A current Member holding Preferred Units. */
export function isPreferredMember(h: AudienceHolder): boolean {
  return isCurrentMember(h) && preferredMicro(h) > 0n;
}

/** A current Member holding Common Units. */
export function isCommonMember(h: AudienceHolder): boolean {
  return isCurrentMember(h) && commonMicro(h) > 0n;
}

/**
 * The statuses that may receive a report (allow-list, as `k1Holders`): a
 * Member, or a Financial-Interest-only holder. PROSPECT and any unexpected
 * value are excluded.
 */
function mayReceiveReports(h: AudienceHolder): boolean {
  return (
    h.memberStatus === "MEMBER" || h.memberStatus === "FINANCIAL_INTEREST_ONLY"
  );
}

/** R22a: a holder with a K-1 attached that may receive reports. */
function isK1Holder(h: AudienceHolder): boolean {
  return h.hasK1 && mayReceiveReports(h);
}

export function isTransferNotice(
  reportType: ReportType,
  noticeKind: string | null | undefined,
): boolean {
  return (
    reportType === "NOTICE" &&
    typeof noticeKind === "string" &&
    (TRANSFER_NOTICE_KINDS as readonly string[]).includes(noticeKind)
  );
}

function ids(
  holders: readonly AudienceHolder[],
  keep: (h: AudienceHolder) => boolean,
) {
  return holders.filter(keep).map((h) => h.stakeholderId);
}

function preset(key: PresetKey, stakeholderIds: string[]): AudiencePreset {
  return { key, label: PRESET_LABELS[key], stakeholderIds };
}

/**
 * P18. The presets that fill the picker, in display order, and the one
 * ticked by default. Ids keep the order of `holders`.
 *
 * - TAX_K1: only "Holders with a K-1 attached" (default; the only source).
 * - Transfer notice: all, Preferred, Common, and "Other Preferred Members"
 *   (Preferred Members minus the transferor; default). Without a transferor
 *   the last preset is omitted and there is no default.
 * - Quarterly, annual and other notices: all, Preferred, Common; default all.
 */
export function audiencePresets(
  reportType: ReportType,
  noticeKind: string | null | undefined,
  holders: readonly AudienceHolder[],
  transferorId: string | null | undefined,
): AudiencePresets {
  if (reportType === "TAX_K1") {
    return {
      presets: [preset("K1_ATTACHED", ids(holders, isK1Holder))],
      defaultPreset: "K1_ATTACHED",
    };
  }
  const base = documentSharePresets(holders);
  if (isTransferNotice(reportType, noticeKind)) {
    if (typeof transferorId !== "string" || transferorId.length === 0) {
      return { presets: base, defaultPreset: null };
    }
    return {
      presets: [
        ...base,
        preset(
          "OTHER_PREFERRED_MEMBERS",
          ids(
            holders,
            (h) => isPreferredMember(h) && h.stakeholderId !== transferorId,
          ),
        ),
      ],
      defaultPreset: "OTHER_PREFERRED_MEMBERS",
    };
  }
  return { presets: base, defaultPreset: "ALL_CURRENT_MEMBERS" };
}

/** P28, 5.6 `shareOptions`: the presets of the document share dialog. */
export function documentSharePresets(
  holders: readonly AudienceHolder[],
): AudiencePreset[] {
  return [
    preset("ALL_CURRENT_MEMBERS", ids(holders, isCurrentMember)),
    preset("PREFERRED_MEMBERS", ids(holders, isPreferredMember)),
    preset("COMMON_MEMBERS", ids(holders, isCommonMember)),
  ];
}

export type AudienceRefusalCode =
  | "EMPTY"
  | "TOO_MANY"
  | "DUPLICATE"
  | "UNKNOWN_HOLDER"
  | "PROSPECT"
  | "INELIGIBLE_STATUS"
  | "K1_MISSING"
  | "NO_NOTICE_ADDRESS"
  | "TRANSFER_NOT_LINKED";

export interface AudienceRefusal {
  code: AudienceRefusalCode;
  /** The offending id; absent for EMPTY, TOO_MANY and TRANSFER_NOT_LINKED. */
  stakeholderId?: string;
  message: string;
}

export type AudienceWarningCode =
  | "MEMBERS_NOT_SELECTED"
  | "K1_HOLDERS_NOT_SELECTED"
  | "TRANSFEROR_SELECTED"
  | "NOT_MEMBERS_SELECTED"
  | "OUTSIDE_DEFAULT_SELECTED"
  | "RECEIVES_NOTHING";

export interface AudienceWarning {
  code: AudienceWarningCode;
  stakeholderIds: string[];
  message: string;
}

export interface AudienceCheck {
  /** Non-empty: the server refuses the release and writes nothing. */
  refusals: AudienceRefusal[];
  /** Shown in the dialog; never block. */
  warnings: AudienceWarning[];
}

export interface AudienceOptions {
  noticeKind?: string | null;
  /** The transferring Member of a transfer notice (`UnitTransfer.fromStakeholderId`). */
  transferorId?: string | null;
  /** "Also send by email" is ticked: every selected holder needs a notice address. */
  email?: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * P18, P19, S4, S5. Refusals (the release is refused, nothing is written):
 *
 * - EMPTY: no holder selected. TOO_MANY: more than 500 distinct holders.
 * - DUPLICATE: an id appears more than once (the stored list must be exactly
 *   what was confirmed, so a malformed list is refused rather than cleaned).
 * - UNKNOWN_HOLDER: not a holder of this company (a foreign or invented id).
 * - PROSPECT: a prospect never receives a report.
 * - INELIGIBLE_STATUS: any other status than MEMBER or
 *   FINANCIAL_INTEREST_ONLY (allow-list; a null or unknown value is refused).
 * - K1_MISSING: on a TAX_K1 report, a holder with no K-1 attached. This keeps
 *   the audience of a K-1 report to the holders whose own K-1 is on it; what
 *   each sees is still limited to its own files (P12).
 * - NO_NOTICE_ADDRESS: email ticked and the holder has no notice address.
 * - TRANSFER_NOT_LINKED: a transfer notice without a transferor.
 *
 * Warnings (departures from the default audience):
 *
 * - MEMBERS_NOT_SELECTED: members of the default audience left out (current
 *   Members; for a transfer notice the other Preferred Members).
 * - K1_HOLDERS_NOT_SELECTED: TAX_K1, holders with a K-1 left out.
 * - TRANSFEROR_SELECTED: transfer notice, the transferring Member selected.
 * - NOT_MEMBERS_SELECTED: not TAX_K1, selected holders that are not current
 *   Members (Financial-Interest-only holders, Members with no units).
 * - OUTSIDE_DEFAULT_SELECTED: transfer notice, current Members outside the
 *   default (Common-only Members).
 * - RECEIVES_NOTHING: email not ticked and the holder has no portal access.
 *
 * Refused ids are left out of the warnings.
 */
export function audienceProblems(
  reportType: ReportType,
  selectedIds: readonly string[],
  holders: readonly AudienceHolder[],
  options: AudienceOptions = {},
): AudienceCheck {
  const refusals: AudienceRefusal[] = [];
  const warnings: AudienceWarning[] = [];
  const byId = new Map<string, AudienceHolder>();
  for (const h of holders) byId.set(h.stakeholderId, h);

  const transfer = isTransferNotice(reportType, options.noticeKind);
  const transferorId =
    typeof options.transferorId === "string" && options.transferorId.length > 0
      ? options.transferorId
      : null;
  if (transfer && transferorId === null) {
    refusals.push({
      code: "TRANSFER_NOT_LINKED",
      message: "This notice is not linked to a transfer.",
    });
  }

  if (selectedIds.length === 0) {
    refusals.push({ code: "EMPTY", message: "Select at least one holder." });
  }

  const seen = new Set<string>();
  const valid: AudienceHolder[] = [];
  for (const id of selectedIds) {
    if (seen.has(id)) {
      refusals.push({
        code: "DUPLICATE",
        stakeholderId: id,
        message: "A holder is listed more than once.",
      });
      continue;
    }
    seen.add(id);
    const h = byId.get(id);
    if (!h) {
      refusals.push({
        code: "UNKNOWN_HOLDER",
        stakeholderId: id,
        message: "A selected holder does not belong to this company.",
      });
      continue;
    }
    let ok = true;
    if (h.memberStatus === "PROSPECT") {
      ok = false;
      refusals.push({
        code: "PROSPECT",
        stakeholderId: id,
        message: "A prospect cannot receive a report.",
      });
    } else if (!mayReceiveReports(h)) {
      ok = false;
      refusals.push({
        code: "INELIGIBLE_STATUS",
        stakeholderId: id,
        message:
          "A selected holder's status does not allow it to receive reports.",
      });
    }
    if (reportType === "TAX_K1" && !h.hasK1) {
      ok = false;
      refusals.push({
        code: "K1_MISSING",
        stakeholderId: id,
        message: "A selected holder has no K-1 attached to this report.",
      });
    }
    if (options.email === true && (h.noticeEmail ?? "").trim().length === 0) {
      ok = false;
      refusals.push({
        code: "NO_NOTICE_ADDRESS",
        stakeholderId: id,
        message: "A selected holder has no notice email address.",
      });
    }
    if (ok) valid.push(h);
  }
  if (seen.size > MAX_AUDIENCE) {
    refusals.push({
      code: "TOO_MANY",
      message: `Select at most ${MAX_AUDIENCE} holders.`,
    });
  }

  // Warnings: the symmetric difference with the default audience.
  const warn = (code: AudienceWarningCode, list: string[], message: string) => {
    if (list.length > 0) warnings.push({ code, stakeholderIds: list, message });
  };

  if (reportType === "TAX_K1") {
    const missing = ids(
      holders,
      (h) => isK1Holder(h) && !seen.has(h.stakeholderId),
    );
    warn(
      "K1_HOLDERS_NOT_SELECTED",
      missing,
      `${plural(missing.length, "holder with a K-1 attached is", "holders with a K-1 attached are")} not selected.`,
    );
  } else {
    const inDefault = (h: AudienceHolder) =>
      transfer
        ? isPreferredMember(h) && h.stakeholderId !== transferorId
        : isCurrentMember(h);
    const missing = ids(
      holders,
      (h) => inDefault(h) && !seen.has(h.stakeholderId),
    );
    warn(
      "MEMBERS_NOT_SELECTED",
      missing,
      transfer
        ? `${plural(missing.length, "other Preferred Member is", "other Preferred Members are")} not selected.`
        : `${plural(missing.length, "current Member is", "current Members are")} not selected.`,
    );
    if (transfer && transferorId !== null && seen.has(transferorId)) {
      warn(
        "TRANSFEROR_SELECTED",
        [transferorId],
        "The transferring Member is selected.",
      );
    }
    const notMembers = valid
      .filter((h) => !isCurrentMember(h) && h.stakeholderId !== transferorId)
      .map((h) => h.stakeholderId);
    warn(
      "NOT_MEMBERS_SELECTED",
      notMembers,
      `${plural(notMembers.length, "selected holder is", "selected holders are")} not Members.`,
    );
    if (transfer) {
      const outside = valid
        .filter(
          (h) =>
            isCurrentMember(h) &&
            !inDefault(h) &&
            h.stakeholderId !== transferorId,
        )
        .map((h) => h.stakeholderId);
      warn(
        "OUTSIDE_DEFAULT_SELECTED",
        outside,
        `${plural(outside.length, "selected Member holds", "selected Members hold")} no Preferred Units.`,
      );
    }
  }

  if (options.email !== true) {
    const nothing = valid
      .filter((h) => h.portal === "NONE")
      .map((h) => h.stakeholderId);
    warn(
      "RECEIVES_NOTHING",
      nothing,
      `${plural(nothing.length, "selected holder has", "selected holders have")} no portal access and will not be emailed: they will receive nothing.`,
    );
  }

  return { refusals, warnings };
}

export type DeadlineOutcome = "DONE" | "STAYS_OPEN" | "K1_COVERAGE";

export interface DeadlineConsequence {
  outcome: DeadlineOutcome;
  /** The sentence shown under "Consequences" in the release dialog. */
  sentence: string;
}

/**
 * P22. Whether release marks the report's compliance deadline done.
 *
 * - QUARTERLY, ANNUAL, NOTICE (a notice can carry a related deadline): DONE
 *   only when email is ticked and every id of `currentMemberIds` is selected,
 *   and there is at least one; otherwise STAYS_OPEN, with the reason.
 *   For a transfer notice the caller passes the default audience (the other
 *   Preferred Members) as `currentMemberIds`.
 * - TAX_K1 without email: STAYS_OPEN (delivered means emailed, 2.9).
 * - TAX_K1 with email: K1_COVERAGE. The year's K-1 deadlines close when every
 *   holder of the year has been emailed a K-1, which depends on other
 *   reports and is decided in the database, not here.
 *
 * Release is the only caller that closes deadlines; the dialog shows the
 * sentence only when a deadline exists.
 */
export function deadlineOutcome(
  reportType: ReportType,
  emailTicked: boolean,
  selectedIds: readonly string[],
  currentMemberIds: readonly string[],
): DeadlineConsequence {
  const manual = "You can complete it by hand on the compliance page.";
  if (reportType === "TAX_K1") {
    if (emailTicked !== true) {
      return {
        outcome: "STAYS_OPEN",
        sentence: `The K-1 deadlines stay open because the report is not emailed. ${manual}`,
      };
    }
    return {
      outcome: "K1_COVERAGE",
      sentence:
        "The K-1 deadlines are marked done once every holder of the year has been emailed a K-1.",
    };
  }
  if (emailTicked !== true) {
    return {
      outcome: "STAYS_OPEN",
      sentence: `The compliance deadline stays open because the report is not emailed. ${manual}`,
    };
  }
  const required = new Set(currentMemberIds);
  if (required.size === 0) {
    return {
      outcome: "STAYS_OPEN",
      sentence: `The compliance deadline stays open because the company has no current Members. ${manual}`,
    };
  }
  const selected = new Set(selectedIds);
  let missing = 0;
  for (const id of required) if (!selected.has(id)) missing += 1;
  if (missing > 0) {
    return {
      outcome: "STAYS_OPEN",
      sentence: `The compliance deadline stays open because ${plural(missing, "current Member is", "current Members are")} not selected. ${manual}`,
    };
  }
  return {
    outcome: "DONE",
    sentence:
      "The compliance deadline will be marked done: every current Member is selected and will be emailed.",
  };
}
