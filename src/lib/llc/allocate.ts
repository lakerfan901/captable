// Largest-remainder pro-rata allocation (R14).

import { LlcMathError } from "./money";

export interface Weighted {
  key: string;
  weight: bigint;
}

export function allocateProRata(
  total: bigint,
  items: readonly Weighted[],
): Map<string, bigint> {
  if (total < 0n)
    throw new LlcMathError("NEGATIVE", "Total must not be negative");
  const seen = new Set<string>();
  let sum = 0n;
  for (const item of items) {
    if (item.weight < 0n) {
      throw new LlcMathError("NEGATIVE", `Negative weight for ${item.key}`);
    }
    if (seen.has(item.key)) {
      throw new LlcMathError("DUPLICATE_KEY", `Duplicate key ${item.key}`);
    }
    seen.add(item.key);
    sum += item.weight;
  }

  const result = new Map<string, bigint>();
  if (total === 0n) {
    for (const item of items) result.set(item.key, 0n);
    return result;
  }
  if (sum === 0n) throw new LlcMathError("ZERO_WEIGHT", "All weights are zero");

  const rows = items.map((item) => {
    const scaled = total * item.weight;
    return { ...item, share: scaled / sum, remainder: scaled % sum };
  });
  let leftover = total;
  for (const row of rows) leftover -= row.share;

  const order = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  for (const row of order) {
    if (leftover === 0n) break;
    row.share += 1n;
    leftover -= 1n;
  }
  for (const row of rows) result.set(row.key, row.share);
  return result;
}
