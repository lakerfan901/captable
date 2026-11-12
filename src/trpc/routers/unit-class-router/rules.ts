// Pure validation for unit class updates. Relative imports only (vitest).

export type UnitClassKind = "PREFERRED" | "COMMON";
export type BalanceReturnStartRule =
  | "LATER_OF_RECEIPT_AND_DUE"
  | "RECEIPT_DATE";

/** Editable terms of a unit class, in wire form (cents as number, units as string). */
export type UnitClassTerms = {
  name: string;
  pricePerUnitCents: number | null;
  authorizedUnits: string | null;
  fractionalUnitsAllowed: boolean;
  votesPerUnit: string;
  prefReturnBps: number;
  balanceReturnStartRule: BalanceReturnStartRule;
  residualSplitBps: number;
  minCommitmentCents: number | null;
  minCommitmentFloorCents: number | null;
  offeringCapCents: number | null;
  initialInstallmentBps: number;
  finalClosingDate: string | null;
  balanceOutsideDate: string | null;
  acceptanceBusinessDays: number;
  refundBusinessDays: number;
};

export type UnitClassCurrent = UnitClassTerms & {
  kind: UnitClassKind;
  issuedUnits: string;
  termsLocked: boolean;
};

export type UnitClassUpdate = UnitClassTerms & {
  confirmAmendment?: boolean;
  amendmentReason?: string;
};

export const UNIT_CLASS_FIELDS = [
  "name",
  "pricePerUnitCents",
  "authorizedUnits",
  "fractionalUnitsAllowed",
  "votesPerUnit",
  "prefReturnBps",
  "balanceReturnStartRule",
  "residualSplitBps",
  "minCommitmentCents",
  "minCommitmentFloorCents",
  "offeringCapCents",
  "initialInstallmentBps",
  "finalClosingDate",
  "balanceOutsideDate",
  "acceptanceBusinessDays",
  "refundBusinessDays",
] as const satisfies readonly (keyof UnitClassTerms)[];

export type UnitClassField = (typeof UNIT_CLASS_FIELDS)[number];

/** Terms fixed by the Operating Agreement once units are issued. */
export const LOCKED_FIELDS: readonly UnitClassField[] = [
  "pricePerUnitCents",
  "fractionalUnitsAllowed",
  "votesPerUnit",
  "prefReturnBps",
  "balanceReturnStartRule",
  "residualSplitBps",
  "minCommitmentCents",
  "minCommitmentFloorCents",
  "offeringCapCents",
  "initialInstallmentBps",
  "authorizedUnits",
  "finalClosingDate",
  "balanceOutsideDate",
];

export const LOCKED_TERMS_MESSAGE =
  "These terms are fixed by the Operating Agreement once units are issued. Changing them requires an amendment under Section 12.1 (and, for Sections 4.8, 4.9 and 5.6, approval of 70% of the Disinterested Preferred Units). Confirm the amendment and give a reason.";

const UNITS_RE = /^\d+(\.\d{1,6})?$/;

/** "100.000000" / "50" → value in millionths of a unit. */
export function unitsToMicro(s: string): bigint {
  const t = s.trim();
  if (!UNITS_RE.test(t)) throw new RangeError(`Invalid units: ${s}`);
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

function sameValue(field: UnitClassField, a: unknown, b: unknown): boolean {
  if (
    (field === "authorizedUnits" || field === "votesPerUnit") &&
    typeof a === "string" &&
    typeof b === "string"
  ) {
    return unitsToMicro(a) === unitsToMicro(b);
  }
  return a === b;
}

/** Fields whose value differs between the current class and the update. */
export function changedFields(
  current: UnitClassTerms,
  next: UnitClassTerms,
): UnitClassField[] {
  return UNIT_CLASS_FIELDS.filter((f) => !sameValue(f, current[f], next[f]));
}

/** Returns the first rule violation as a human message, or null when valid. */
export function validateUnitClassUpdate(
  current: UnitClassCurrent,
  next: UnitClassUpdate,
): string | null {
  if (current.kind === "PREFERRED") {
    if (next.pricePerUnitCents === null || next.pricePerUnitCents <= 0) {
      return "Preferred Units need a price per unit greater than zero (Section 4.1).";
    }
    const floor = next.minCommitmentFloorCents;
    const min = next.minCommitmentCents;
    const cap = next.offeringCapCents;
    if (floor === null || min === null || cap === null) {
      return "Preferred Units need a minimum commitment, a waiver floor and an offering cap (Sections 3.7 and 4.8).";
    }
    if (!(floor > 0 && floor <= min && min <= cap)) {
      return "The waiver floor must be above zero and not above the minimum commitment, and the minimum must not exceed the offering cap (Sections 3.7 and 4.8).";
    }
  } else {
    if (
      next.pricePerUnitCents !== null ||
      next.minCommitmentCents !== null ||
      next.minCommitmentFloorCents !== null ||
      next.offeringCapCents !== null ||
      next.finalClosingDate !== null ||
      next.balanceOutsideDate !== null
    ) {
      return "Common Units are not sold: price, minimum, floor, cap and offering dates must be empty.";
    }
    if (
      next.authorizedUnits === null ||
      unitsToMicro(next.authorizedUnits) <= 0n
    ) {
      return "Common Units need an authorized number of units greater than zero (Section 3.2).";
    }
  }

  if (
    next.authorizedUnits !== null &&
    unitsToMicro(next.authorizedUnits) < unitsToMicro(current.issuedUnits)
  ) {
    return "Cannot authorize fewer units than are issued";
  }

  if (
    next.finalClosingDate !== null &&
    next.balanceOutsideDate !== null &&
    next.finalClosingDate > next.balanceOutsideDate
  ) {
    return "The Final Closing Date must not be after the Balance outside date (Sections 4.8 and 4.9).";
  }

  if (current.termsLocked) {
    const lockedChanges = changedFields(current, next).filter((f) =>
      LOCKED_FIELDS.includes(f),
    );
    if (
      lockedChanges.length > 0 &&
      !(
        next.confirmAmendment === true &&
        (next.amendmentReason ?? "").trim().length >= 10
      )
    ) {
      return LOCKED_TERMS_MESSAGE;
    }
  }

  return null;
}
