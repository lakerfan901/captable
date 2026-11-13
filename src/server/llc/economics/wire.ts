/**
 * Wire conversion for economics outputs (02-economics.md E7). Pure, relative
 * imports only (tested without the `@/` alias).
 *
 * - `bigint` under a key that contains "units" (any case) → 6-dp string;
 * - any other `bigint` → `number` (|v| ≤ Number.MAX_SAFE_INTEGER, else RangeError);
 * - a Prisma `Decimal` (any object with `toFixed` and `d`/`e`/`s`) → 6-dp string;
 * - `Map` → plain object keyed by its (string) keys, `Set` → array;
 * - `Date`, strings, numbers, booleans, `null`, `undefined` pass through.
 *
 * Arrays, `Map` values and `Set` items inherit the key they sit under, so
 * `{ commonUnits: Map<id, bigint> }` becomes `{ commonUnits: { id: "100.000000" } }`.
 */
import { microUnitsToDecimalString } from "../../../lib/llc/money";
import { unitsToWire } from "../serialize";

type DecimalLike = {
  toFixed(dp?: number): string;
  d: unknown;
  e: unknown;
  s: unknown;
};

type UnitsKey = `${string}${"units" | "Units" | "UNITS"}${string}`;

/** `T` with every bigint replaced by number, except under keys containing "units" (any case), which become 6-dp strings. */
export type Wire<T, K = ""> = T extends bigint
  ? K extends UnitsKey
    ? string
    : number
  : T extends string | number | boolean | null | undefined | Date
    ? T
    : T extends DecimalLike
      ? string
      : T extends ReadonlyMap<infer MK, infer V>
        ? Record<MK & string, Wire<V, K>>
        : T extends ReadonlySet<infer V>
          ? Wire<V, K>[]
          : T extends readonly (infer E)[]
            ? Wire<E, K>[]
            : T extends object
              ? { [P in keyof T]: Wire<T[P], P> }
              : T;

const UNITS_RE = /units/i;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function isDecimalLike(v: object): v is DecimalLike {
  return (
    typeof (v as { toFixed?: unknown }).toFixed === "function" &&
    "d" in v &&
    "e" in v &&
    "s" in v
  );
}

function convert(value: unknown, key: string): unknown {
  if (typeof value === "bigint") {
    if (UNITS_RE.test(key)) return microUnitsToDecimalString(value);
    if (value > MAX_SAFE || value < -MAX_SAFE) {
      throw new RangeError(
        `Value ${value} under "${key}" exceeds the safe integer range`,
      );
    }
    return Number(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (isDecimalLike(value)) return unitsToWire(value);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) {
      if (typeof k !== "string") {
        throw new TypeError(`Map under "${key}" has a non-string key`);
      }
      out[k] = convert(v, key);
    }
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => convert(v, key));
  if (Array.isArray(value)) return value.map((v) => convert(v, key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = convert(v, k);
  return out;
}

export function toWire<T>(value: T): Wire<T> {
  return convert(value, "") as Wire<T>;
}
