import { describe, expect, it } from "vitest";
import {
  forfeitureUnits,
  sumCashApplied,
  sumUnits,
  validateSpecialReceipt,
} from "./receipt-rules";

const $ = (dollars: number) => BigInt(Math.round(dollars * 100));

type Input = Parameters<typeof validateSpecialReceipt>[0];

const replacement = (over: Partial<Input> = {}): Input => ({
  kind: "REPLACEMENT",
  status: "ACCEPTED",
  isReplacement: true,
  amountCents: $(30_000),
  appliedCents: $(30_000),
  acceptedCents: $(30_000),
  cashAppliedCents: 0n,
  receivedOn: "2027-04-10",
  today: "2027-04-10",
  memberCapitalCents: 0n,
  ...over,
});

const codes = (input: Input) =>
  validateSpecialReceipt(input).map((e) => e.code);

describe("validateSpecialReceipt: REPLACEMENT", () => {
  it("accepts a full funding of an accepted replacement commitment", () => {
    expect(codes(replacement())).toEqual([]);
  });

  it("refuses a commitment that is not a Replacement Funder commitment", () => {
    expect(codes(replacement({ isReplacement: false }))).toEqual(["NOT_OPEN"]);
  });

  it("refuses a replacement commitment that is not accepted", () => {
    expect(codes(replacement({ status: "PENDING" }))).toEqual(["NOT_OPEN"]);
    expect(codes(replacement({ status: "REJECTED" }))).toEqual(["NOT_OPEN"]);
  });

  it("G1: funds a replacement commitment accepted at a reduced amount", () => {
    expect(codes(replacement({ status: "REDUCED" }))).toEqual([]);
  });

  it("refuses an applied amount that differs from the cash received", () => {
    expect(codes(replacement({ appliedCents: $(29_999.99) }))).toEqual([
      "AMOUNT_INVALID",
    ]);
  });

  it("refuses a zero amount", () => {
    expect(codes(replacement({ amountCents: 0n, appliedCents: 0n }))).toEqual([
      "AMOUNT_INVALID",
    ]);
  });

  it("refuses a future receipt date", () => {
    expect(codes(replacement({ receivedOn: "2027-04-11" }))).toEqual([
      "DATE_ORDER",
    ]);
  });

  it("refuses an overpayment of the accepted amount", () => {
    const errors = validateSpecialReceipt(
      replacement({
        cashAppliedCents: $(20_000),
        amountCents: $(10_000.01),
        appliedCents: $(10_000.01),
      }),
    );
    expect(errors.map((e) => e.code)).toEqual(["OVERPAYMENT"]);
    expect(errors[0]?.message).toBe(
      "Only $10,000.00 of the Balance is outstanding.",
    );
  });
});

describe("validateSpecialReceipt: CREDIT", () => {
  const credit = (over: Partial<Input> = {}): Input =>
    replacement({
      kind: "CREDIT",
      isReplacement: false,
      status: "ACCEPTED",
      amountCents: 0n,
      appliedCents: $(5_000),
      acceptedCents: $(250_000),
      cashAppliedCents: $(250_000),
      ...over,
    });

  it("accepts a positive credit, even beyond the commitment", () => {
    expect(codes(credit())).toEqual([]);
    expect(codes(credit({ status: "REDUCED" }))).toEqual([]);
  });

  it("refuses a commitment that is not ACCEPTED or REDUCED", () => {
    expect(codes(credit({ status: "PENDING" }))).toEqual(["NOT_OPEN"]);
    expect(codes(credit({ status: "REJECTED" }))).toEqual(["NOT_OPEN"]);
  });

  it("refuses cash on a credit", () => {
    expect(codes(credit({ amountCents: 1n }))).toEqual(["AMOUNT_INVALID"]);
  });

  it("refuses a credit that is not positive", () => {
    expect(codes(credit({ appliedCents: 0n }))).toEqual(["AMOUNT_INVALID"]);
    expect(codes(credit({ appliedCents: -1n }))).toEqual(["AMOUNT_INVALID"]);
  });
});

describe("validateSpecialReceipt: FORFEITURE", () => {
  const forfeiture = (over: Partial<Input> = {}): Input =>
    replacement({
      kind: "FORFEITURE",
      isReplacement: false,
      status: "ACCEPTED",
      amountCents: 0n,
      appliedCents: -$(20_000),
      acceptedCents: $(100_000),
      cashAppliedCents: $(40_000),
      memberCapitalCents: $(40_000),
      ...over,
    });

  it("accepts a forfeiture that leaves capital at or above zero", () => {
    expect(codes(forfeiture())).toEqual([]);
    expect(codes(forfeiture({ appliedCents: -$(40_000) }))).toEqual([]);
  });

  it("refuses a commitment that is not ACCEPTED or REDUCED", () => {
    expect(codes(forfeiture({ status: "PENDING" }))).toEqual(["NOT_OPEN"]);
    expect(codes(forfeiture({ status: "REJECTED" }))).toEqual(["NOT_OPEN"]);
  });

  it("refuses cash on a forfeiture", () => {
    expect(codes(forfeiture({ amountCents: 1n }))).toEqual(["AMOUNT_INVALID"]);
  });

  it("refuses a forfeiture that is not negative", () => {
    expect(codes(forfeiture({ appliedCents: 0n }))).toEqual(["AMOUNT_INVALID"]);
  });

  it("refuses a forfeiture that would make capital negative", () => {
    const errors = validateSpecialReceipt(
      forfeiture({ appliedCents: -$(40_000.01) }),
    );
    expect(errors.map((e) => e.code)).toEqual(["AMOUNT_INVALID"]);
    expect(errors[0]?.message).toBe(
      "The member's capital is $40,000.00; forfeiting $40,000.01 would make it negative.",
    );
  });
});

describe("sums and units", () => {
  it("cash applied counts INITIAL, BALANCE and REPLACEMENT only", () => {
    expect(
      sumCashApplied([
        { kind: "INITIAL", appliedCents: $(100_000) },
        { kind: "BALANCE", appliedCents: $(150_000) },
        { kind: "REPLACEMENT", appliedCents: $(30_000) },
        { kind: "CREDIT", appliedCents: $(5_000) },
        { kind: "FORFEITURE", appliedCents: -$(20_000) },
      ]),
    ).toBe($(280_000));
  });

  it("sums unit strings exactly", () => {
    expect(sumUnits(["100.000000", "0.000010", "-20.000000"])).toBe(
      "80.000010",
    );
    expect(sumUnits([])).toBe("0.000000");
  });

  it("forfeiture units are the negative of the units for the amount", () => {
    expect(forfeitureUnits(-$(20_000), $(1_000), true)).toBe("-20.000000");
    expect(forfeitureUnits(-4_020_000n, $(1_000), true)).toBe("-40.200000");
    expect(forfeitureUnits(-4_020_000n, $(1_000), false)).toBe("-40.000000");
  });
});
