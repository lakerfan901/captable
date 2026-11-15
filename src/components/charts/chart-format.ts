// Formatting and number conversion of the chart kit (04-investor-portal.md
// 5.9 "Charts", package P14). Pure: relative imports only, tested.
//
// Every figure a chart, tooltip, table or KPI tile prints goes through this
// module, which wraps the shared formatters (`formatCents`, `formatDpi`,
// `formatDateOnly`, `periodLabel`) and adds the compact axis labels and the
// signed changes. bigint values reach the plotting library only through
// `plotNumber`, the one place where a bigint becomes a JavaScript number.

import { formatDateOnly } from "../../lib/date-only";
import { formatDpi } from "../../lib/llc/financial-series";
import { roundDiv } from "../../lib/llc/money";
import { centsToNumber, formatCents } from "../../lib/money";

export { formatDpi };

/** What a raw value measures: cents, basis points of a percentage, or DPI basis points of "x". */
export type ValueUnit = "cents" | "bps" | "dpiBps";

export type RawValue = bigint | number | null;

const toBig = (v: bigint | number): bigint =>
  typeof v === "bigint" ? v : BigInt(Math.round(v));

/**
 * The number a chart plots for a raw value: cents stay cents (a safe integer;
 * RangeError beyond ±2^53, see `centsToNumber`), basis points stay basis
 * points. Null stays null: a missing value is drawn as a gap, never a zero.
 */
export function plotNumber(raw: RawValue): number | null {
  if (raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) {
      throw new RangeError(`Chart value ${raw} is not a safe integer`);
    }
    return raw;
  }
  return centsToNumber(raw);
}

/** "$1,234,567.89"; "—" for null. */
export function formatMoney(cents: RawValue): string {
  if (cents === null) return "—";
  return formatCents(toBig(cents));
}

/** 9160 → "91.60%"; −250 → "-2.50%"; null → "—". Integer arithmetic. */
export function formatPercentBps(bps: RawValue): string {
  if (bps === null) return "—";
  const b = toBig(bps);
  const neg = b < 0n;
  const abs = neg ? -b : b;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

/** The full value of a raw figure in its unit (tooltips, tables, tiles). */
export function formatValue(unit: ValueUnit, raw: RawValue): string {
  if (raw === null) return "—";
  switch (unit) {
    case "cents":
      return formatMoney(raw);
    case "bps":
      return formatPercentBps(raw);
    case "dpiBps":
      return formatDpi(toBig(raw));
  }
}

const COMPACT_STEPS: readonly { div: number; suffix: string }[] = [
  { div: 1e11, suffix: "B" }, // cents → billions of dollars
  { div: 1e8, suffix: "M" },
  { div: 1e5, suffix: "K" },
];

/** Up to `digits` decimals, trailing zeros dropped: 1.20 → "1.2", 3.00 → "3". */
function trimmed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * Compact dollars for axes and end labels: 123_456_789 cents → "$1.23M",
 * 41_220_000 → "$412.2K", 95_000 → "$950", 0 → "$0", negatives "-$1.2M".
 * Rounded for display only (never used for a figure a reader must sum).
 */
export function formatMoneyCompact(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  for (const s of COMPACT_STEPS) {
    if (abs >= s.div) {
      const v = abs / s.div;
      return `${neg ? "-" : ""}$${trimmed(v, v >= 100 ? 1 : 2)}${s.suffix}`;
    }
  }
  const dollars = Math.round(abs / 100);
  return dollars === 0
    ? "$0"
    : `${neg ? "-" : ""}$${dollars.toLocaleString("en-US")}`;
}

/** Axis tick in the unit: compact dollars, "50%", "1.25x". */
export function formatTick(unit: ValueUnit, v: number): string {
  switch (unit) {
    case "cents":
      return formatMoneyCompact(v);
    case "bps":
      return `${trimmed(v / 100, 1)}%`;
    case "dpiBps":
      return `${trimmed(v / 10_000, 2)}x`;
  }
}

/**
 * A unit amount (micro-units) with thousands separators and its exact
 * decimals, trailing zeros dropped: 1050000000n → "1,050"; 12345670n →
 * "12.34567".
 */
export function formatUnits(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = (abs / 1_000_000n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "Nov 30, 2026". */
export function formatDate(iso: string): string {
  return formatDateOnly(iso);
}

// ---------------------------------------------------------------------------
// Changes

/**
 * A percentage change in basis points of a percent-of-1 (10000 = +100%, the
 * `Change.pctBps` of financial-periods) as an unsigned text with one
 * decimal, half away from zero: 1234n → "12.3%".
 */
export function formatChangePct(pctBps: bigint): string {
  const abs = pctBps < 0n ? -pctBps : pctBps;
  const tenths = roundDiv(abs, 10n);
  return `${(tenths / 10n).toLocaleString("en-US")}.${tenths % 10n}%`;
}

/** A difference of two percentages in basis points as points: 70 → "0.7 pts". */
export function formatChangePoints(diffBps: bigint): string {
  const abs = diffBps < 0n ? -diffBps : diffBps;
  const tenths = roundDiv(abs, 10n);
  return `${tenths / 10n}.${tenths % 10n} pts`;
}

/** The unsigned size of a change, as a tile prints it after "Up" / "Down". */
export function formatChangeAmount(
  unit: ValueUnit,
  amount: bigint,
  pctBps: bigint | null,
  preferPct: boolean,
): string {
  const abs = amount < 0n ? -amount : amount;
  switch (unit) {
    case "cents":
      return preferPct && pctBps !== null
        ? formatChangePct(pctBps)
        : formatCents(abs);
    case "bps":
      return formatChangePoints(abs);
    case "dpiBps":
      return formatDpi(abs);
  }
}

// ---------------------------------------------------------------------------
// Axis scale

export interface NiceScale {
  min: number;
  max: number;
  ticks: number[];
}

const NICE_STEPS = [1, 1.25, 2, 2.5, 5, 10] as const;

/**
 * Clean ticks for the values (nulls ignored), always including zero, about
 * `count` intervals, extended to negatives when a value is below zero. With
 * no values or all zeros: 0 … `fallbackMax`.
 */
export function niceScale(
  values: readonly (number | null)[],
  count = 4,
  fallbackMax = 100,
): NiceScale {
  const present = values.filter((v): v is number => v !== null);
  // 4% headroom so a line at the maximum is not drawn on the plot's edge
  let lo = Math.min(0, ...present) * 1.04;
  let hi = Math.max(0, ...present) * 1.04;
  if (lo === 0 && hi === 0) hi = fallbackMax;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (NICE_STEPS.find((s) => s * mag >= raw - 1e-9) ?? 10) * mag;
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) {
    ticks.push(Math.abs(t) < step / 1e6 ? 0 : Number(t.toPrecision(12)));
  }
  return { min: ticks[0] ?? 0, max: ticks[ticks.length - 1] ?? hi, ticks };
}
