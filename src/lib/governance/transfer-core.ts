// Unit transfers under Section 7 of the Operating Agreement: the pure rules
// (03-governance.md G16, rules R31–R40). No database, no clock: callers pass
// `today` and the transferor's units. Relative imports only (vitest).

import { fromMicro, toMicro } from "../llc/voting";
import type { Ymd } from "./dates";

export const TRANSFER_KINDS = [
  "VOLUNTARY",
  "PERMITTED_TRANSFEREE",
  "INVOLUNTARY",
  "DEATH_INCAPACITY",
] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export const TRANSFER_STATUSES = ["OPEN", "COMPLETED", "CANCELLED"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const ROFR_OUTCOMES = [
  "NOT_APPLICABLE",
  "PENDING",
  "NOT_EXERCISED",
  "EXERCISED_BY_MANAGER",
  "EXERCISED_BY_MEMBERS",
] as const;
export type RofrOutcome = (typeof ROFR_OUTCOMES)[number];

export const CONSENT_VALUES = [
  "NOT_REQUIRED",
  "PENDING",
  "GRANTED",
  "DENIED",
] as const;
export type ConsentValue = (typeof CONSENT_VALUES)[number];

/** Section 7.6: counsel's opinion delivered, or waived by the Manager. */
export const SECURITIES_OPINIONS = ["RECEIVED", "WAIVED"] as const;
export type SecuritiesOpinion = (typeof SECURITIES_OPINIONS)[number];

/** Rule keys of the compliance deadlines a transfer pushes (G14 table). */
export const TRANSFER_DEADLINE_RULES = [
  "TRANSFER_NOTICE_COPY",
  "TRANSFER_ROFR_MANAGER",
  "TRANSFER_ROFR_MEMBERS",
  "TRANSFER_CLOSE_BY",
  "TRANSFER_PURCHASE_CLOSE",
] as const;
export type TransferDeadlineRule = (typeof TRANSFER_DEADLINE_RULES)[number];

/** `{ruleKey}:{UnitTransfer.id}`, unique per company. */
export function transferDeadlineKey(
  rule: TransferDeadlineRule,
  transferId: string,
): string {
  return `${rule}:${transferId}`;
}

/** The common resolution matter that approves a Common Unit transfer (R38). */
export const COMMON_TRANSFER_MATTER = "COMMON_TRANSFER_OR_CONTROL";

/** Voluntary and involuntary transfers have the 7.1 / 7.2 copy and refusal periods. */
export function hasRofr(kind: TransferKind): boolean {
  return kind === "VOLUNTARY" || kind === "INVOLUNTARY";
}

/** The UnitTransfer scalar fields as plain values. */
export interface TransferState {
  kind: TransferKind;
  status: TransferStatus;
  fromStakeholderId: string;
  toStakeholderId: string | null;
  unitClassKind: "PREFERRED" | "COMMON";
  /** 6-decimal string */
  units: string;
  noticeReceivedOn: Ymd;
  noticeCopyDueOn: Ymd | null;
  managerRofrEndsOn: Ymd | null;
  memberRofrEndsOn: Ymd | null;
  closeByOn: Ymd | null;
  rofrOutcome: RofrOutcome;
  rofrDecidedOn: Ymd | null;
  rofrNote: string | null;
  managerConsent: ConsentValue;
  securitiesOpinion: SecuritiesOpinion | null;
  priceEstablishedOn: Ymd | null;
  purchaseCloseByOn: Ymd | null;
  transferNoticeOn: Ymd | null;
  effectiveOn: Ymd | null;
  exemptUnder71: boolean;
  exemptNote: string | null;
  admissionSignaturePage: boolean;
  admissionExpensesPaid: boolean;
  admissionQualified: boolean;
  admissionManagerConsent: boolean;
  admittedOn: Ymd | null;
}

export interface CompletionContext {
  today: Ymd;
  /** Transferor's units of the class (6-decimal string), earlier completed transfers deducted. */
  fromUnits: string;
  /** null when no transferee is selected */
  toMemberStatus: string | null;
  linkedResolution: { status: string; matterKey: string | null } | null;
}

/** Section 7.1 / 7.2 / 7.3 starting values of the ROFR outcome and the Manager consent. */
export function initialFlags(kind: TransferKind): {
  rofrOutcome: RofrOutcome;
  managerConsent: ConsentValue;
} {
  switch (kind) {
    case "VOLUNTARY":
      return { rofrOutcome: "PENDING", managerConsent: "PENDING" };
    case "INVOLUNTARY":
      return { rofrOutcome: "PENDING", managerConsent: "NOT_REQUIRED" };
    case "PERMITTED_TRANSFEREE":
    case "DEATH_INCAPACITY":
      return { rofrOutcome: "NOT_APPLICABLE", managerConsent: "NOT_REQUIRED" };
  }
}

function blank(s: string | null): boolean {
  return s === null || s.trim() === "";
}

/** "150.000000" → "150", "25.500000" → "25.5". */
export function displayUnits(units: string): string {
  if (!units.includes(".")) return units;
  return units.replace(/0+$/, "").replace(/\.$/, "");
}

function micro(units: string): bigint | null {
  try {
    return toMicro(units);
  } catch {
    return null;
  }
}

/** Section 7.8 (R36): the admission checklist. Empty = may be admitted. */
export function admissionErrors(t: TransferState): string[] {
  const errors: string[] = [];
  if (!t.admissionSignaturePage) {
    errors.push("Exhibit B signature page not received (7.8(a)).");
  }
  if (!t.admissionExpensesPaid) {
    errors.push("Admission expenses not paid or waived (7.8(b)).");
  }
  if (!t.admissionQualified) {
    errors.push("Qualification not confirmed (7.8(c)).");
  }
  if (t.kind !== "PERMITTED_TRANSFEREE" && !t.admissionManagerConsent) {
    errors.push("Manager consent to admission not recorded (7.8(d)).");
  }
  return errors;
}

/** Every rule that stops the transfer from being completed. Empty = may complete. */
export function completionErrors(
  t: TransferState,
  ctx: CompletionContext,
): string[] {
  const errors: string[] = [];

  // 1.
  if (t.status !== "OPEN") errors.push("This transfer is closed.");

  // 2.
  if (t.toStakeholderId === null) {
    errors.push("Select the transferee.");
  } else if (t.toStakeholderId === t.fromStakeholderId) {
    errors.push("Transferor and transferee must differ.");
  }

  // 3.
  const units = micro(t.units);
  const held = micro(ctx.fromUnits) ?? 0n;
  if (units === null || units <= 0n || units > held) {
    errors.push(
      `The transferor holds only ${displayUnits(fromMicro(held))} units.`,
    );
  }

  // 4. (R35)
  if (t.transferNoticeOn === null) {
    errors.push(
      "Enter the date the Manager received written notice of the transfer (Section 7.9.1).",
    );
  } else if (t.transferNoticeOn > ctx.today) {
    errors.push("The notice date cannot be in the future.");
  }

  // 5. Voluntary transfer (R31).
  if (t.kind === "VOLUNTARY") {
    if (t.managerConsent !== "GRANTED") {
      errors.push("The Manager's written consent is required (Section 7.1).");
    }
    if (t.rofrOutcome === "PENDING" || t.rofrOutcome === "NOT_APPLICABLE") {
      errors.push(
        "Record the outcome of the right of first refusal (Section 7.1).",
      );
    }
    if (t.rofrOutcome === "NOT_EXERCISED") {
      if (t.rofrDecidedOn === null) {
        // Fail closed: without a date the 90 days cannot be shown to have run.
        errors.push(
          "Enter the date the right of first refusal was decided (Section 7.1).",
        );
      } else if (
        t.memberRofrEndsOn !== null &&
        t.rofrDecidedOn < t.memberRofrEndsOn &&
        blank(t.rofrNote)
      ) {
        errors.push(
          "The 90-day refusal period has not ended. Add a note that every holder of the right waived it in writing.",
        );
      }
      if (
        t.transferNoticeOn !== null &&
        t.closeByOn !== null &&
        t.transferNoticeOn > t.closeByOn
      ) {
        errors.push(
          "The 180-day period to complete the transfer has ended (Section 7.1). A new Transfer Notice is required.",
        );
      }
    }
  }

  // 6. Securities law (R39).
  if (
    (t.kind === "VOLUNTARY" || t.kind === "PERMITTED_TRANSFEREE") &&
    t.securitiesOpinion === null
  ) {
    errors.push(
      "Record the opinion of counsel or the Manager's waiver (Section 7.6).",
    );
  }

  // 7. Common Units (R38).
  if (t.unitClassKind === "COMMON") {
    const exempt = t.exemptUnder71 && !blank(t.exemptNote);
    const approved =
      ctx.linkedResolution !== null &&
      ctx.linkedResolution.status === "EFFECTIVE" &&
      ctx.linkedResolution.matterKey === COMMON_TRANSFER_MATTER;
    if (!exempt && !approved) {
      errors.push(
        "A transfer of Common Units requires the approval of a Preferred Supermajority (Section 7.1).",
      );
    }
  }

  // 8. A Member cannot hold some Units as a Financial Interest only.
  if (ctx.toMemberStatus === "MEMBER" && admissionErrors(t).length > 0) {
    errors.push(
      "The transferee is already a Member: complete the admission checklist for these Units (Section 7.8) before completing.",
    );
  }

  return errors;
}
