// Preferred Return primitives (R4, R5): accrual start, simple interest, capital lots.

import { allocateProRata } from "./allocate";
import { type IsoDate, maxIso } from "./dates";
import { type Cents, LlcMathError, type MicroUnits, roundDiv } from "./money";
import type { ContributionEvent } from "./positions";

/** FORFEITURE receipts are not lots; they become FORFEITURE events. */
export type ReceiptKind = "INITIAL" | "BALANCE" | "REPLACEMENT" | "CREDIT";

export function resolvePrefReturnStart(i: {
  kind: ReceiptKind;
  receivedOn: IsoDate;
  lineDueOn: IsoDate | null;
  balanceOutsideDate: IsoDate | null;
  rule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE";
}): IsoDate {
  if (i.kind !== "BALANCE" || i.rule === "RECEIPT_DATE") return i.receivedOn;
  const due = i.lineDueOn ?? i.balanceOutsideDate;
  if (due === null) {
    throw new LlcMathError(
      "TERMS_INCOMPLETE",
      "Balance receipt without a Call Notice line needs a balance outside date (§4.9)",
    );
  }
  return maxIso(i.receivedOn, due);
}

/** roundDiv(principal × days × bps, basis × 10_000). */
export function simpleInterest(
  principal: Cents,
  days: number,
  bps: number,
  basis: number,
): Cents {
  if (days < 0) {
    throw new LlcMathError(
      "NEGATIVE_DAYS",
      `Days must not be negative: ${days}`,
    );
  }
  return roundDiv(
    principal * BigInt(days) * BigInt(bps),
    BigInt(basis) * 10_000n,
  );
}

export interface ReceiptRow {
  receiptId: string;
  holderId: string;
  kind: ReceiptKind;
  /** appliedOn: the date capital and units exist */
  on: IsoDate;
  receivedOn: IsoDate;
  /** appliedCents */
  amount: Cents;
  /** unitsIssued */
  units: MicroUnits;
  /** CapitalReceipt.prefReturnStartDate */
  prefReturnStartOn: IsoDate;
  seq: number;
}

/** Net of reversals, amount > 0. */
export interface AllocationRow {
  receiptId: string;
  amount: Cents;
  prefReturnStartOn: IsoDate;
}

export function buildCapitalLots(
  receipts: readonly ReceiptRow[],
  allocations: readonly AllocationRow[],
): ContributionEvent[] {
  const out: ContributionEvent[] = [];
  for (const r of receipts) {
    const parts: { lotId: string; amount: Cents; start: IsoDate }[] = [];
    let allocated = 0n;
    let index = 0;
    for (const a of allocations) {
      if (a.receiptId !== r.receiptId) continue;
      if (a.amount <= 0n) {
        throw new LlcMathError(
          "BAD_ALLOCATION",
          `Allocation on ${r.receiptId} must be positive`,
        );
      }
      parts.push({
        lotId: `${r.receiptId}:${index}`,
        amount: a.amount,
        start: a.prefReturnStartOn,
      });
      allocated += a.amount;
      index++;
    }
    if (allocated > r.amount) {
      throw new LlcMathError(
        "OVER_ALLOCATED",
        `Allocations on ${r.receiptId} exceed the receipt amount`,
      );
    }
    const rest = r.amount - allocated;
    if (rest > 0n) {
      parts.push({
        lotId: `${r.receiptId}:rest`,
        amount: rest,
        start: r.prefReturnStartOn,
      });
    }
    const units = allocateProRata(
      r.units,
      parts.map((p) => ({ key: p.lotId, weight: p.amount })),
    );
    for (const p of parts) {
      out.push({
        kind: "CONTRIBUTION",
        on: r.on,
        seq: r.seq,
        holderId: r.holderId,
        lotId: p.lotId,
        amount: p.amount,
        units: units.get(p.lotId) ?? 0n,
        accrualStartOn: p.start,
      });
    }
  }
  return out;
}
