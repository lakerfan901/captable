import { z } from "zod";

/** Upper bound for a cents amount on the wire ($10 billion). */
export const CENTS_MAX = 1_000_000_000_000;

const DOLLARS_RE = /^\d+(\.\d{1,2})?$/;

/** Parses "$100,000.00", "100,000", " 250000 " to cents; null when invalid. */
export function parseDollarsToCents(text: string): bigint | null {
  let s = text.trim();
  if (s.startsWith("$")) s = s.slice(1);
  s = s.replace(/,/g, "").replace(/\s+/g, "");
  if (!DOLLARS_RE.test(s)) return null;
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

/** "$1,234,567.89"; negative as "-$40,000.00". Integer math only. */
export function formatCents(cents: bigint | number): string {
  const value = typeof cents === "bigint" ? cents : numberToCents(cents);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function centsToNumber(b: bigint): number {
  if (b > MAX_SAFE || b < -MAX_SAFE) {
    throw new RangeError(`Cents value ${b} exceeds the safe integer range`);
  }
  return Number(b);
}

export function numberToCents(n: number): bigint {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Cents value ${n} is not a safe integer`);
  }
  return BigInt(n);
}

/** cents × bps / 10000, rounded up. */
export function mulBpsCeil(cents: bigint, bps: number): bigint {
  return (cents * BigInt(bps) + 9999n) / 10000n;
}

/** a × b / c, rounded half up (c > 0). */
export function mulDivRoundHalfUp(a: bigint, b: bigint, c: bigint): bigint {
  return (2n * a * b + c) / (2n * c);
}

export const ZCents = z.number().int().min(0).max(CENTS_MAX);
