// Management Fee (OA §6.18, R22): 5% of Gross Revenue, accrued monthly, paid quarterly.

import { compareIso, type IsoDate } from "./dates";
import { type Cents, LlcMathError, roundDiv } from "./money";

export interface RevenueMonth {
  month: IsoDate /* first of month */;
  customerReceipts: Cents;
  passThroughFees: Cents;
  otherIncome: Cents;
  assetSaleProceeds: Cents;
  insuranceProceeds: Cents;
  managementFee: Cents;
}

/** Customer receipts less pass-through fees (may be negative). */
export function grossRevenue(
  m: Pick<RevenueMonth, "customerReceipts" | "passThroughFees">,
): Cents {
  return m.customerReceipts - m.passThroughFees;
}

/** roundDiv(gross × bps, 10_000), rounded per month; a negative gross gives a negative accrual. */
export function managementFeeForMonth(gross: Cents, bps: number): Cents {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new LlcMathError(
      "BAD_BPS",
      `Fee rate must be a non-negative integer, got ${bps}`,
    );
  }
  return roundDiv(gross * BigInt(bps), 10_000n);
}

/** A month is in range when its first day is in [from, to]; "toDate" means through range.to. */
export function managementFeeSummary(
  months: readonly RevenueMonth[],
  feePayments: readonly { paidOn: IsoDate; amount: Cents }[],
  range: { from: IsoDate; to: IsoDate },
): {
  accruedInRange: Cents;
  paidInRange: Cents;
  accruedToDate: Cents;
  paidToDate: Cents;
  unpaid: Cents;
} {
  let accruedInRange = 0n;
  let accruedToDate = 0n;
  for (const m of months) {
    if (compareIso(m.month, range.to) > 0) continue;
    accruedToDate += m.managementFee;
    if (compareIso(m.month, range.from) >= 0) accruedInRange += m.managementFee;
  }
  let paidInRange = 0n;
  let paidToDate = 0n;
  for (const p of feePayments) {
    if (compareIso(p.paidOn, range.to) > 0) continue;
    paidToDate += p.amount;
    if (compareIso(p.paidOn, range.from) >= 0) paidInRange += p.amount;
  }
  return {
    accruedInRange,
    paidInRange,
    accruedToDate,
    paidToDate,
    unpaid: accruedToDate - paidToDate,
  };
}
