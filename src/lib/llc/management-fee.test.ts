import { describe, expect, it } from "vitest";
import {
  grossRevenue,
  managementFeeForMonth,
  managementFeeSummary,
  type RevenueMonth,
} from "./management-fee";

function month(
  m: string,
  receipts: bigint,
  fees: bigint,
  otherIncome = 0n,
): RevenueMonth {
  const gross = receipts - fees;
  return {
    month: m,
    customerReceipts: receipts,
    passThroughFees: fees,
    otherIncome,
    assetSaleProceeds: 0n,
    insuranceProceeds: 0n,
    managementFee: managementFeeForMonth(gross, 500),
  };
}

describe("management fee", () => {
  it("MF-1", () => {
    const g = grossRevenue({
      customerReceipts: 4_825_000n,
      passThroughFees: 723_750n,
    });
    expect(g).toBe(4_101_250n);
    expect(managementFeeForMonth(g, 500)).toBe(205_063n);
  });

  it("MF-2", () => {
    const g = grossRevenue({
      customerReceipts: 5_190_040n,
      passThroughFees: 778_506n,
    });
    expect(g).toBe(4_411_534n);
    expect(managementFeeForMonth(g, 500)).toBe(220_577n);
  });

  it("MF-3", () => {
    const g = grossRevenue({
      customerReceipts: 3_987_525n,
      passThroughFees: 598_129n,
    });
    expect(g).toBe(3_389_396n);
    expect(managementFeeForMonth(g, 500)).toBe(169_470n);
  });

  it("MF-4 negative month", () => {
    const g = grossRevenue({
      customerReceipts: 100_000n,
      passThroughFees: 120_000n,
    });
    expect(g).toBe(-20_000n);
    expect(managementFeeForMonth(g, 500)).toBe(-1_000n);
  });

  it("MF-5 rounding", () => {
    expect(managementFeeForMonth(10n, 500)).toBe(1n);
    expect(managementFeeForMonth(29n, 500)).toBe(1n);
    expect(managementFeeForMonth(30n, 500)).toBe(2n);
  });

  it("MF-6 summary", () => {
    const months = [
      month("2027-04-01", 4_825_000n, 723_750n),
      month("2027-05-01", 5_190_040n, 778_506n),
      month("2027-06-01", 3_987_525n, 598_129n),
    ];
    const payments = [{ paidOn: "2027-07-20", amount: 595_110n }];
    expect(
      managementFeeSummary(months, payments, {
        from: "2027-04-01",
        to: "2027-06-30",
      }),
    ).toEqual({
      accruedInRange: 595_110n,
      paidInRange: 0n,
      accruedToDate: 595_110n,
      paidToDate: 0n,
      unpaid: 595_110n,
    });
    const q3 = managementFeeSummary(months, payments, {
      from: "2027-07-01",
      to: "2027-09-30",
    });
    expect(q3.paidToDate).toBe(595_110n);
    expect(q3.paidInRange).toBe(595_110n);
    expect(q3.accruedInRange).toBe(0n);
    expect(q3.unpaid).toBe(0n);
  });
});
