/**
 * Checks for the receipt kinds that only ECONOMICS records through
 * `recordCapitalReceipt` (REPLACEMENT, CREDIT, FORFEITURE), plus small sums
 * used by the ledger services. Pure and relative-import only so it can be
 * unit tested; the admission rules themselves live in
 * `src/lib/admission/commitment-rules.ts`.
 */
import {
  type CommitmentStatus,
  type ReceiptKind,
  type RuleError,
  validateCashReceipt,
} from "../../lib/admission/commitment-rules";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "../../lib/llc/money";
import { microUnitsForAmount } from "../../lib/llc/units";
import { formatCents } from "../../lib/money";

export type SpecialReceiptKind = "REPLACEMENT" | "CREDIT" | "FORFEITURE";

const CASH_KINDS: ReadonlySet<ReceiptKind> = new Set([
  "INITIAL",
  "BALANCE",
  "REPLACEMENT",
]);

/** Σ appliedCents of INITIAL, BALANCE and REPLACEMENT rows (never CREDIT/FORFEITURE). */
export function sumCashApplied(
  receipts: { kind: ReceiptKind; appliedCents: bigint }[],
): bigint {
  return receipts.reduce(
    (sum, r) => (CASH_KINDS.has(r.kind) ? sum + r.appliedCents : sum),
    0n,
  );
}

/**
 * Ledger invariant of one commitment (H1). With `receipts` = its non-void
 * receipts:
 *
 *   cash received = cash applied as capital + refundDueCents   (decided)
 *   cash received = cash held undecided, nothing applied, no refund (PENDING)
 *
 * where `refundDueCents` = refunds paid (`refundPaidCents`) + refund still
 * due; and cash applied never exceeds `acceptedCents` (CREDIT and
 * FORFEITURE rows carry no cash and are not part of either sum; a credit
 * may exceed the commitment). Also 0 ≤ applied ≤ amount on every cash row,
 * 0 ≤ refundPaid ≤ refundDue, and the commitment's capital and units are
 * not negative. Returns the violated clauses (empty = holds).
 */
export function ledgerInvariantErrors(
  commitment: {
    status: CommitmentStatus;
    acceptedCents: bigint;
    refundDueCents: bigint;
    refundPaidCents: bigint;
  },
  receipts: {
    kind: ReceiptKind;
    amountCents: bigint;
    appliedCents: bigint;
    unitsIssued: string;
  }[],
): string[] {
  const errors: string[] = [];
  const cash = receipts.filter((r) => CASH_KINDS.has(r.kind));
  const received = cash.reduce((s, r) => s + r.amountCents, 0n);
  const applied = sumCashApplied(receipts);
  const capital = receipts.reduce((s, r) => s + r.appliedCents, 0n);
  const units = receipts.reduce(
    (s, r) => s + microUnitsFromDecimal(r.unitsIssued),
    0n,
  );
  for (const r of cash) {
    if (r.appliedCents < 0n || r.appliedCents > r.amountCents) {
      errors.push(
        `a cash receipt has ${r.appliedCents} applied of ${r.amountCents}`,
      );
    }
  }
  if (commitment.status === "PENDING") {
    if (applied !== 0n) errors.push(`pending but ${applied} applied`);
    if (commitment.refundDueCents !== 0n) {
      errors.push(`pending but refund due ${commitment.refundDueCents}`);
    }
  } else if (received !== applied + commitment.refundDueCents) {
    errors.push(
      `received ${received} ≠ applied ${applied} + refund due ${commitment.refundDueCents}`,
    );
  }
  if (applied > commitment.acceptedCents && commitment.status !== "PENDING") {
    errors.push(`applied ${applied} > accepted ${commitment.acceptedCents}`);
  }
  if (
    commitment.refundPaidCents < 0n ||
    commitment.refundPaidCents > commitment.refundDueCents
  ) {
    errors.push(
      `refund paid ${commitment.refundPaidCents} outside 0..${commitment.refundDueCents}`,
    );
  }
  if (capital < 0n) errors.push(`capital ${capital} < 0`);
  if (units < 0n) errors.push(`units ${units} < 0`);
  return errors;
}

/** Σ of 6-dp unit strings, exact. */
export function sumUnits(units: string[]): string {
  return microUnitsToDecimalString(
    units.reduce((sum, u) => sum + microUnitsFromDecimal(u), 0n),
  );
}

/** Units removed by a forfeiture of `appliedCents` (< 0): a negative 6-dp string. */
export function forfeitureUnits(
  appliedCents: bigint,
  pricePerUnitCents: bigint,
  fractionalAllowed: boolean,
): string {
  return microUnitsToDecimalString(
    -microUnitsForAmount(-appliedCents, pricePerUnitCents, fractionalAllowed),
  );
}

export function validateSpecialReceipt(input: {
  kind: SpecialReceiptKind;
  status: CommitmentStatus;
  isReplacement: boolean;
  amountCents: bigint;
  appliedCents: bigint;
  acceptedCents: bigint;
  cashAppliedCents: bigint;
  receivedOn: string;
  today: string;
  /** Σ appliedCents of the member's non-void receipts in the class. */
  memberCapitalCents: bigint;
}): RuleError[] {
  const errors: RuleError[] = [];
  const active = input.status === "ACCEPTED" || input.status === "REDUCED";

  switch (input.kind) {
    case "REPLACEMENT": {
      if (!input.isReplacement || !active) {
        errors.push({
          code: "NOT_OPEN",
          message:
            "A Replacement Funder payment can only be recorded on an accepted Replacement Funder commitment (Section 4.9(ii)).",
        });
        return errors;
      }
      if (input.appliedCents !== input.amountCents) {
        errors.push({
          code: "AMOUNT_INVALID",
          message:
            "A Replacement Funder payment is applied in full: the applied amount must equal the amount received.",
        });
      }
      errors.push(
        ...validateCashReceipt({
          status: input.status,
          acceptedCents: input.acceptedCents,
          cashAppliedCents: input.cashAppliedCents,
          amountCents: input.amountCents,
          receivedOn: input.receivedOn,
          today: input.today,
        }),
      );
      return errors;
    }
    case "CREDIT": {
      if (!active) {
        errors.push({
          code: "NOT_OPEN",
          message:
            "A credit can only be recorded on an accepted commitment (Section 4.9(iv)).",
        });
        return errors;
      }
      if (input.amountCents !== 0n) {
        errors.push({
          code: "AMOUNT_INVALID",
          message:
            "A credit carries no cash: the amount received must be zero.",
        });
      }
      if (input.appliedCents <= 0n) {
        errors.push({
          code: "AMOUNT_INVALID",
          message: "The credited amount must be more than zero.",
        });
      }
      errors.push(...notInFuture(input.receivedOn, input.today, "credit"));
      return errors;
    }
    case "FORFEITURE": {
      if (!active) {
        errors.push({
          code: "NOT_OPEN",
          message:
            "A forfeiture can only be recorded on an accepted commitment (Section 4.9(iv)).",
        });
        return errors;
      }
      if (input.amountCents !== 0n) {
        errors.push({
          code: "AMOUNT_INVALID",
          message:
            "A forfeiture carries no cash: the amount received must be zero.",
        });
      }
      if (input.appliedCents >= 0n) {
        errors.push({
          code: "AMOUNT_INVALID",
          message: "The forfeited amount must be negative.",
        });
      } else if (input.memberCapitalCents + input.appliedCents < 0n) {
        errors.push({
          code: "AMOUNT_INVALID",
          message: `The member's capital is ${formatCents(input.memberCapitalCents)}; forfeiting ${formatCents(-input.appliedCents)} would make it negative.`,
        });
      }
      errors.push(...notInFuture(input.receivedOn, input.today, "forfeiture"));
      return errors;
    }
  }
}

function notInFuture(date: string, today: string, what: string): RuleError[] {
  return date > today
    ? [
        {
          code: "DATE_ORDER",
          message: `The date of the ${what} cannot be in the future.`,
        },
      ]
    : [];
}

type LedgerRow = {
  kind: ReceiptKind;
  amountCents: bigint;
  appliedCents: bigint;
  unitsIssued: string;
};

/** Σ (amount − applied) of cash rows: the refund a decided commitment owes (H1). */
export function refundDueFromReceipts(receipts: LedgerRow[]): bigint {
  return receipts.reduce(
    (sum, r) =>
      CASH_KINDS.has(r.kind) ? sum + r.amountCents - r.appliedCents : sum,
    0n,
  );
}

/**
 * Checks a void and returns the commitment's refund due after it (H1, M1).
 * `refundDueCents` is null for a PENDING commitment (nothing is applied or
 * refundable yet). On a decided commitment the refund due is re-derived from
 * the receipts that remain, so the ledger invariant (`ledgerInvariantErrors`)
 * holds after the void. Refused:
 * - on an ACCEPTED/REDUCED commitment, a cash receipt that the decision split
 *   (0 < applied < amount): voiding it would undo part of the decision, and a
 *   re-recorded receipt could not reproduce the keep the Manager chose;
 * - when the refund still due would fall below what has already been refunded;
 * - when the member's capital or units, on this commitment or in the class,
 *   would become negative (a later FORFEITURE; void the forfeiture first).
 */
export function planVoid(input: {
  status: CommitmentStatus;
  receipt: LedgerRow;
  refundPaidCents: bigint;
  /** The commitment's other non-void receipts. */
  remaining: LedgerRow[];
  /** The member's capital and units in the class without this receipt. */
  memberCapitalAfterCents: bigint;
  memberUnitsAfter: string;
}): { errors: RuleError[]; refundDueCents: bigint | null } {
  const { receipt } = input;
  const errors: RuleError[] = [];
  const active = input.status === "ACCEPTED" || input.status === "REDUCED";
  const isCash = CASH_KINDS.has(receipt.kind);
  const unapplied = isCash ? receipt.amountCents - receipt.appliedCents : 0n;
  if (active && isCash && receipt.appliedCents > 0n && unapplied > 0n) {
    errors.push({
      code: "NOT_OPEN",
      message: `This receipt was split when the commitment was accepted (${formatCents(receipt.appliedCents)} applied as capital, ${formatCents(unapplied)} to be refunded), so it cannot be voided: the ledger cannot undo part of an acceptance. Record the refund with Record refund when it is paid; any other correction of this receipt needs an administrator to correct the database.`,
    });
  }
  const refundDueCents =
    input.status === "PENDING" ? null : refundDueFromReceipts(input.remaining);
  if (refundDueCents !== null && refundDueCents < input.refundPaidCents) {
    errors.push({
      code: "NOT_OPEN",
      message: `${formatCents(input.refundPaidCents)} has already been refunded on this commitment; voiding this receipt would leave only ${formatCents(refundDueCents)} to refund, so it cannot be voided.`,
    });
  }
  const lowers =
    receipt.appliedCents > 0n ||
    microUnitsFromDecimal(receipt.unitsIssued) > 0n;
  if (lowers) {
    const capital = input.remaining.reduce((s, r) => s + r.appliedCents, 0n);
    const units = input.remaining.reduce(
      (s, r) => s + microUnitsFromDecimal(r.unitsIssued),
      0n,
    );
    const memberUnits = microUnitsFromDecimal(input.memberUnitsAfter);
    if (
      capital < 0n ||
      units < 0n ||
      input.memberCapitalAfterCents < 0n ||
      memberUnits < 0n
    ) {
      const capitalAfter =
        capital < 0n ? capital : input.memberCapitalAfterCents;
      const unitsAfter = units < 0n ? units : memberUnits;
      errors.push({
        code: "AMOUNT_INVALID",
        message: `Voiding this receipt would leave the member with negative capital (${formatCents(capitalAfter)}) or units (${microUnitsToDecimalString(unitsAfter)}) because of a forfeiture recorded after it. Void the forfeiture first.`,
      });
    }
  }
  return { errors, refundDueCents };
}
