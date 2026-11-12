/** Prisma Decimal (or anything with toFixed) → 6-dp string; null → "0.000000". */
export function unitsToWire(
  d: { toFixed(n: number): string } | null | undefined,
): string {
  return d ? d.toFixed(6) : "0.000000";
}

/** Calendar date (UTC midnight) → `YYYY-MM-DD`. */
export function dateToWire(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** "40.200000" → "40.2", "100.000000" → "100". */
export function trimUnits(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}
