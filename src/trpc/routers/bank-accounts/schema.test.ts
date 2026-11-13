import { describe, expect, it } from "vitest";
import {
  accountLast4,
  maskAccountNumber,
  nextPrimaryFlag,
  ZodCreateBankAccountSchema,
} from "./schema";

const valid = {
  beneficiaryName: " Octagon GPU I LLC ",
  beneficiaryAddress: "1 Main St",
  bankName: "First Bank",
  bankAddress: "2 Bank Rd",
  accountNumber: "000123456789",
  routingNumber: "021000021",
  accountType: "CHECKING" as const,
};

describe("ZodCreateBankAccountSchema", () => {
  it("accepts and trims a valid input", () => {
    const r = ZodCreateBankAccountSchema.parse(valid);
    expect(r.beneficiaryName).toBe("Octagon GPU I LLC");
    expect(r.swiftCode).toBeUndefined();
  });
  it("accepts 8 and 11 character SWIFT codes", () => {
    expect(
      ZodCreateBankAccountSchema.safeParse({ ...valid, swiftCode: "CHASUS33" })
        .success,
    ).toBe(true);
    expect(
      ZodCreateBankAccountSchema.safeParse({
        ...valid,
        swiftCode: "CHASUS33XXX",
      }).success,
    ).toBe(true);
    expect(
      ZodCreateBankAccountSchema.safeParse({ ...valid, swiftCode: "chasus33" })
        .success,
    ).toBe(false);
  });
  it.each([
    ["routingNumber", "12345678"],
    ["routingNumber", "12345678a"],
    ["accountNumber", "123"],
    ["accountNumber", "1234 5678"],
    ["accountNumber", "1".repeat(35)],
    ["bankName", "   "],
    ["bankName", "x".repeat(201)],
    ["accountType", "BROKERAGE"],
  ])("rejects %s = %j", (key, value) => {
    expect(
      ZodCreateBankAccountSchema.safeParse({ ...valid, [key]: value }).success,
    ).toBe(false);
  });
});

describe("masking", () => {
  it("shows only the last four characters", () => {
    expect(accountLast4("000123456789")).toBe("6789");
    expect(maskAccountNumber("000123456789")).toBe("•••• 6789");
    expect(maskAccountNumber("000123456789")).not.toContain("0001234");
  });
});

describe("nextPrimaryFlag", () => {
  it("first account is primary", () => {
    expect(nextPrimaryFlag([])).toBe(true);
  });
  it("second account takes the opposite flag", () => {
    expect(nextPrimaryFlag([{ primary: true }])).toBe(false);
    expect(nextPrimaryFlag([{ primary: false }])).toBe(true);
  });
  it("third account is rejected", () => {
    expect(nextPrimaryFlag([{ primary: true }, { primary: false }])).toBe(null);
  });
});
