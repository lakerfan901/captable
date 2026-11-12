/**
 * Admission rules for Preferred Unit commitments and capital receipts
 * (Operating Agreement Sections 3.7, 4.8, 4.9, 5.6(b)). Pure: no database,
 * no clock; business-day arithmetic is injected.
 */
import { formatCents, mulBpsCeil, mulDivRoundHalfUp } from "../money";

export type RuleCode =
  | "TERMS_INCOMPLETE"
  | "AMOUNT_INVALID"
  | "DATE_ORDER"
  | "AFTER_FINAL_CLOSING"
  | "BELOW_FLOOR"
  | "MINIMUM_WAIVER_REQUIRED"
  | "CAP_EXCEEDED"
  | "INITIAL_INSTALLMENT_SHORT"
  | "KEEP_OUT_OF_RANGE"
  | "OVERPAYMENT"
  | "NOT_OPEN";
export type RuleError = { code: RuleCode; message: string };
export type OfferingTerms = {
  minCommitmentCents: bigint | null;
  minCommitmentFloorCents: bigint | null;
  offeringCapCents: bigint | null;
  initialInstallmentBps: number;
  finalClosingDate: string | null;
  balanceOutsideDate: string | null;
  acceptanceBusinessDays: number;
  refundBusinessDays: number;
  prefReturnBps: number;
  balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE";
};
export type HeldReceipt = {
  id: string;
  receivedOn: string;
  amountCents: bigint;
};
export type AddBusinessDays = (date: string, n: number) => string;

export type CommitmentStatus = "PENDING" | "ACCEPTED" | "REDUCED" | "REJECTED";
export type ReceiptKind =
  | "INITIAL"
  | "BALANCE"
  | "REPLACEMENT"
  | "CREDIT"
  | "FORFEITURE";

/** Thrown where a rule has no error list to return to (e.g. a rejected commitment). */
export class RuleViolation extends Error {
  readonly code: RuleCode;
  constructor(code: RuleCode, message: string) {
    super(message);
    this.name = "RuleViolation";
    this.code = code;
  }
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a >= b ? a : b);
const minDate = (a: string, b: string) => (a <= b ? a : b);

function byReceivedOnThenId(a: HeldReceipt, b: HeldReceipt): number {
  if (a.receivedOn !== b.receivedOn)
    return a.receivedOn < b.receivedOn ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function bpsToPct(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0
    ? String(whole)
    : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** Section 4.9(a): not less than `bps` of the accepted amount, rounded up. */
export function requiredInitialInstallmentCents(
  acceptedCents: bigint,
  bps: number,
): bigint {
  return mulBpsCeil(acceptedCents, bps);
}

/** B18: pro rata share of held cash, never more than the accepted amount. */
export function defaultKeepCents(input: {
  heldCents: bigint;
  acceptedCents: bigint;
  committedCents: bigint;
}): bigint {
  const { heldCents, acceptedCents, committedCents } = input;
  return minBig(
    acceptedCents,
    mulDivRoundHalfUp(heldCents, acceptedCents, committedCents),
  );
}

export type AcceptanceInput = {
  terms: OfferingTerms;
  committedCents: bigint;
  acceptedCents: bigint;
  acceptedOn: string;
  signedOn: string | null;
  today: string;
  heldCents: bigint;
  keepCents: bigint;
  otherAcceptedCents: bigint;
  minimumWaived: boolean;
  isReplacement: boolean;
  skipClosingDateCheck: boolean;
};

export function validateAcceptance(input: AcceptanceInput): RuleError[] {
  const { terms } = input;
  const min = terms.minCommitmentCents;
  const floor = terms.minCommitmentFloorCents;
  const cap = terms.offeringCapCents;
  const closing = terms.finalClosingDate;
  if (min === null || floor === null || cap === null || closing === null) {
    return [
      {
        code: "TERMS_INCOMPLETE",
        message:
          "Set the minimum, cap and Final Closing Date of the unit class first.",
      },
    ];
  }

  const errors: RuleError[] = [];
  const accepted = input.acceptedCents;

  if (!(accepted > 0n && accepted <= input.committedCents)) {
    errors.push({
      code: "AMOUNT_INVALID",
      message:
        "The accepted amount must be more than zero and not more than the amount committed.",
    });
  }

  if (input.acceptedOn > input.today) {
    errors.push({
      code: "DATE_ORDER",
      message: "The acceptance date cannot be in the future.",
    });
  }
  if (input.signedOn !== null && input.acceptedOn < input.signedOn) {
    errors.push({
      code: "DATE_ORDER",
      message: "The acceptance date cannot be before the signature date.",
    });
  }

  if (
    input.acceptedOn > closing &&
    !input.isReplacement &&
    !input.skipClosingDateCheck
  ) {
    errors.push({
      code: "AFTER_FINAL_CLOSING",
      message: `No Preferred Member may be admitted after the Final Closing Date (${closing}) (Section 4.8).`,
    });
  }

  if (!input.isReplacement) {
    if (accepted < floor) {
      errors.push({
        code: "BELOW_FLOOR",
        message: `The minimum Capital Contribution cannot be waived below ${formatCents(floor)} (Section 3.7).`,
      });
    } else if (accepted < min && !input.minimumWaived) {
      errors.push({
        code: "MINIMUM_WAIVER_REQUIRED",
        message: `${formatCents(accepted)} is below the ${formatCents(min)} minimum. Tick the waiver to admit at not less than ${formatCents(floor)} (Section 3.7).`,
      });
    }
  }

  if (input.otherAcceptedCents + accepted > cap) {
    const remaining = cap - input.otherAcceptedCents;
    errors.push({
      code: "CAP_EXCEEDED",
      message: `Accepting ${formatCents(accepted)} would exceed the ${formatCents(cap)} cap; ${formatCents(remaining > 0n ? remaining : 0n)} remains (Section 4.8).`,
    });
  }

  const required = input.isReplacement
    ? 0n
    : requiredInitialInstallmentCents(accepted, terms.initialInstallmentBps);
  if (!input.isReplacement && input.heldCents < required) {
    errors.push({
      code: "INITIAL_INSTALLMENT_SHORT",
      message: `Received ${formatCents(input.heldCents)}; at least ${formatCents(required)} (${bpsToPct(terms.initialInstallmentBps)}% of the accepted amount) must be received before acceptance (Section 4.9).`,
    });
  } else {
    const max = minBig(input.heldCents, accepted);
    if (input.keepCents < required || input.keepCents > max) {
      errors.push({
        code: "KEEP_OUT_OF_RANGE",
        message: `The amount kept must be between ${formatCents(required)} and ${formatCents(max)}.`,
      });
    }
  }

  return errors;
}

/** Applies `keepCents` to held receipts in (receivedOn, id) order. */
export function allocateHeldReceipts(
  receipts: HeldReceipt[],
  keepCents: bigint,
): { id: string; appliedCents: bigint }[] {
  let remaining = keepCents;
  return [...receipts].sort(byReceivedOnThenId).map((r) => {
    const applied = remaining > 0n ? minBig(r.amountCents, remaining) : 0n;
    remaining -= applied;
    return { id: r.id, appliedCents: applied };
  });
}

export function refundDueCents(heldCents: bigint, keepCents: bigint): bigint {
  return heldCents - keepCents;
}

/**
 * Date from which a receipt's capital and units exist: never before the money
 * arrived and never before the acceptance (H2). Every path that applies a
 * receipt (acceptance, cash receipt, special receipt) uses this.
 */
export function appliedOnDate(receivedOn: string, acceptedOn: string): string {
  return maxDate(receivedOn, acceptedOn);
}

/**
 * Cash held at the acceptance (H2): only receipts received on or before
 * `acceptedOn` count for the Initial Installment and the keep/refund split.
 */
export function heldOnOrBefore(
  receipts: HeldReceipt[],
  acceptedOn: string,
): bigint {
  return receipts.reduce(
    (sum, r) => (r.receivedOn <= acceptedOn ? sum + r.amountCents : sum),
    0n,
  );
}

export type AcceptancePlanRow = {
  id: string;
  kind: "INITIAL" | "BALANCE";
  appliedCents: bigint;
  /** `appliedOnDate(receivedOn, acceptedOn)` when applied > 0, else null. */
  appliedOn: string | null;
};

/**
 * How the held receipts of a commitment are applied when it is accepted.
 * Receipts received on or before `acceptedOn` are the Initial Installment:
 * `keepCents` of them is applied in (receivedOn, id) order (B18) and the rest
 * is refunded. Receipts received after `acceptedOn` are ordinary Balance
 * payments (B16): applied in full on their own date, up to
 * `acceptedCents − keepCents` in (receivedOn, id) order; any excess is
 * refunded (F5 rule 10: excess held cash is refunded at the decision).
 * Σ applied + refund = Σ amount, and Σ applied ≤ acceptedCents.
 */
export function planAcceptance(input: {
  receipts: HeldReceipt[];
  acceptedOn: string;
  acceptedCents: bigint;
  keepCents: bigint;
}): { rows: AcceptancePlanRow[]; refundCents: bigint } {
  const { acceptedOn } = input;
  const initial = input.receipts.filter((r) => r.receivedOn <= acceptedOn);
  const later = input.receipts
    .filter((r) => r.receivedOn > acceptedOn)
    .sort(byReceivedOnThenId);
  const byId = new Map(input.receipts.map((r) => [r.id, r]));
  const rows: AcceptancePlanRow[] = allocateHeldReceipts(
    initial,
    input.keepCents,
  ).map((a) => ({
    id: a.id,
    kind: "INITIAL",
    appliedCents: a.appliedCents,
    appliedOn: a.appliedCents > 0n ? acceptedOn : null,
  }));
  let room = input.acceptedCents - input.keepCents;
  for (const r of later) {
    const applied = room > 0n ? minBig(r.amountCents, room) : 0n;
    room -= applied;
    rows.push({
      id: r.id,
      kind: "BALANCE",
      appliedCents: applied,
      appliedOn: applied > 0n ? appliedOnDate(r.receivedOn, acceptedOn) : null,
    });
  }
  const received = rows.reduce(
    (sum, row) => sum + (byId.get(row.id)?.amountCents ?? 0n),
    0n,
  );
  const applied = rows.reduce((sum, row) => sum + row.appliedCents, 0n);
  return { rows, refundCents: received - applied };
}

export function decisionStatus(
  acceptedCents: bigint,
  committedCents: bigint,
): "ACCEPTED" | "REDUCED" {
  if (acceptedCents === committedCents) return "ACCEPTED";
  if (acceptedCents > 0n && acceptedCents < committedCents) return "REDUCED";
  throw new RuleViolation(
    "AMOUNT_INVALID",
    "The accepted amount must be more than zero and not more than the amount committed.",
  );
}

export type SubscriptionClock = {
  clockStart: string | null;
  acceptanceDeadline: string | null;
  effectiveDecisionDeadline: string | null;
  refundDueBy: string | null;
};

/** Section 4.8: 10 business days to decide, 5 more to refund. */
export function computeSubscriptionClock(
  input: {
    signedOn: string | null;
    committedCents: bigint;
    initialInstallmentBps: number;
    receipts: HeldReceipt[];
    acceptanceBusinessDays: number;
    refundBusinessDays: number;
    finalClosingDate: string | null;
  },
  addBusinessDays: AddBusinessDays,
): SubscriptionClock {
  const none: SubscriptionClock = {
    clockStart: null,
    acceptanceDeadline: null,
    effectiveDecisionDeadline: null,
    refundDueBy: null,
  };
  const threshold = mulBpsCeil(
    input.committedCents,
    input.initialInstallmentBps,
  );
  let total = 0n;
  let installmentOn: string | null = null;
  for (const r of [...input.receipts].sort(byReceivedOnThenId)) {
    total += r.amountCents;
    if (total >= threshold) {
      installmentOn = r.receivedOn;
      break;
    }
  }
  if (input.signedOn === null || installmentOn === null) return none;
  const clockStart = maxDate(input.signedOn, installmentOn);
  const acceptanceDeadline = addBusinessDays(
    clockStart,
    input.acceptanceBusinessDays,
  );
  return {
    clockStart,
    acceptanceDeadline,
    effectiveDecisionDeadline:
      input.finalClosingDate === null
        ? acceptanceDeadline
        : minDate(acceptanceDeadline, input.finalClosingDate),
    refundDueBy: addBusinessDays(acceptanceDeadline, input.refundBusinessDays),
  };
}

/** B16: kind of a cash receipt recorded against a commitment. */
export function deriveReceiptKind(input: {
  status: CommitmentStatus;
  acceptedOn: string | null;
  receivedOn: string;
}): "INITIAL" | "BALANCE" {
  if (input.status === "PENDING") return "INITIAL";
  if (input.status === "REJECTED") {
    throw new RuleViolation(
      "NOT_OPEN",
      "The commitment was rejected; no money can be recorded against it.",
    );
  }
  if (input.acceptedOn === null) {
    throw new RuleViolation(
      "NOT_OPEN",
      "The commitment has no acceptance date.",
    );
  }
  return input.receivedOn <= input.acceptedOn ? "INITIAL" : "BALANCE";
}

/**
 * Sections 4.9, 5.6(b); B17. `null` = no return accrues; `undefined` = the
 * Balance outside date is needed but not set (caller raises TERMS_INCOMPLETE).
 */
export function prefReturnStartDate(input: {
  kind: ReceiptKind;
  receivedOn: string;
  dueDate: string | null;
  terms: Pick<
    OfferingTerms,
    "prefReturnBps" | "balanceReturnStartRule" | "balanceOutsideDate"
  >;
}): string | null | undefined {
  const { kind, receivedOn, dueDate, terms } = input;
  if (terms.prefReturnBps === 0) return null;
  switch (kind) {
    case "INITIAL":
    case "REPLACEMENT":
    case "CREDIT":
      return receivedOn;
    case "FORFEITURE":
      return null;
    case "BALANCE": {
      if (terms.balanceReturnStartRule === "RECEIPT_DATE") return receivedOn;
      const due = dueDate ?? terms.balanceOutsideDate;
      if (due === null) return undefined;
      return maxDate(receivedOn, due);
    }
  }
}

export function validateCashReceipt(input: {
  status: CommitmentStatus;
  acceptedCents: bigint;
  cashAppliedCents: bigint;
  amountCents: bigint;
  receivedOn: string;
  today: string;
}): RuleError[] {
  if (input.status === "REJECTED") {
    return [
      {
        code: "NOT_OPEN",
        message:
          "The commitment was rejected; no money can be recorded against it.",
      },
    ];
  }
  const errors: RuleError[] = [];
  if (input.amountCents <= 0n) {
    errors.push({
      code: "AMOUNT_INVALID",
      message: "The amount received must be more than zero.",
    });
  }
  if (input.receivedOn > input.today) {
    errors.push({
      code: "DATE_ORDER",
      message: "The date received cannot be in the future.",
    });
  }
  if (
    input.status !== "PENDING" &&
    input.cashAppliedCents + input.amountCents > input.acceptedCents
  ) {
    errors.push({
      code: "OVERPAYMENT",
      message: `Only ${formatCents(outstandingBalanceCents(input.acceptedCents, input.cashAppliedCents))} of the Balance is outstanding.`,
    });
  }
  return errors;
}

/** Cash applied = INITIAL + BALANCE + REPLACEMENT applied cents (never CREDIT/FORFEITURE). */
export function outstandingBalanceCents(
  acceptedCents: bigint,
  cashAppliedCents: bigint,
): bigint {
  const diff = acceptedCents - cashAppliedCents;
  return diff > 0n ? diff : 0n;
}
