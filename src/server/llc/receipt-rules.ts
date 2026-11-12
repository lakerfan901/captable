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
      if (!input.isReplacement || input.status !== "ACCEPTED") {
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
      return errors;
    }
  }
}
