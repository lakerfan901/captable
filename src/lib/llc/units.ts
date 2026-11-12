// Units from cash (R1, R2) and percentage helpers.

import {
  LlcMathError,
  type MicroUnits,
  microUnitsToDecimalString,
  roundDiv,
} from "./money";

export function microUnitsForAmount(
  amountCents: bigint,
  pricePerUnitCents: bigint,
  fractionalAllowed: boolean,
): MicroUnits {
  if (pricePerUnitCents <= 0n || amountCents < 0n) {
    throw new LlcMathError(
      "BAD_UNITS_INPUT",
      "Price must be positive and amount must not be negative",
    );
  }
  const micro = (amountCents * 1_000_000n) / pricePerUnitCents;
  return fractionalAllowed ? micro : (micro / 1_000_000n) * 1_000_000n;
}

export function unitsForAmount(
  amountCents: bigint,
  pricePerUnitCents: bigint,
  fractionalAllowed: boolean,
): string {
  return microUnitsToDecimalString(
    microUnitsForAmount(amountCents, pricePerUnitCents, fractionalAllowed),
  );
}

/** Display fraction in millionths: 25% → 250000; 0 when total = 0. */
export function unitFractionMillionths(
  units: MicroUnits,
  totalUnits: MicroUnits,
): number {
  if (totalUnits === 0n) return 0;
  return Number(roundDiv(units * 1_000_000n, totalUnits));
}

/** Wire percentage with 4 decimals: "22.2222"; "0.0000" when total = 0. */
export function pctString(units: MicroUnits, totalUnits: MicroUnits): string {
  const millionths =
    totalUnits === 0n ? 0n : roundDiv(units * 1_000_000n, totalUnits);
  const negative = millionths < 0n;
  const abs = (negative ? -millionths : millionths).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${abs.slice(0, -4)}.${abs.slice(-4)}`;
}
