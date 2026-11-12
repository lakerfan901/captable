// Pure money and unit primitives for the LLC economics library.
// No parsing or formatting of dollars here (use src/lib/money.ts).

export type Cents = bigint;
export type MicroUnits = bigint;

export class LlcMathError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LlcMathError";
  }
}

/** Integer division rounded half away from zero. `d` must be > 0. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) {
    throw new LlcMathError("BAD_DIVISOR", `Divisor must be positive, got ${d}`);
  }
  if (n < 0n) return -roundDiv(-n, d);
  return (2n * n + d) / (2n * d);
}

function splitScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, "0");
  const intPart = abs.slice(0, abs.length - decimals);
  const fracPart = abs.slice(abs.length - decimals);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/** 123456n → "1234.56"; -5n → "-0.05". */
export function centsToDecimalString(c: Cents): string {
  return splitScaled(c, 2);
}

const UNITS_RE = /^-?\d+(\.\d{1,6})?$/;

/** "12.345670" or a Prisma Decimal → 12345670n. */
export function microUnitsFromDecimal(
  v: string | { toString(): string },
): MicroUnits {
  const s = typeof v === "string" ? v : v.toString();
  if (!UNITS_RE.test(s)) {
    throw new LlcMathError("BAD_UNITS", `Not a 6-dp unit amount: ${s}`);
  }
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [intPart = "0", fracPart = ""] = body.split(".");
  const abs = BigInt(intPart) * 1_000_000n + BigInt(fracPart.padEnd(6, "0"));
  return negative ? -abs : abs;
}

/** 12345670n → "12.345670". */
export function microUnitsToDecimalString(u: MicroUnits): string {
  return splitScaled(u, 6);
}
