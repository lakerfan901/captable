import { describe, expect, it } from "vitest";
import {
  exhibitATemplateCsv,
  parseExhibitACsv,
  parseExhibitADate,
} from "./exhibit-a-csv";

const PRICE = { pricePerUnitCents: 100_000n };
const HEADER =
  "Member,Capital Contribution Committed,Paid to Date,Preferred Units,Preferred Unit Percentage Interest,Date Admitted,Notice Address and Email";
const JANE = `Jane Doe,"$250,000.00","$100,000.00",100,71.4286%,11/13/2026,"1 Main St, Frankfort, KY 40601; jane@example.com"`;
const ACME = `Acme Holdings LLC,100000,40000,40,28.5714%,2026-11-16,"2 Oak Ave, Cheyenne, WY 82001; ops@acme.test"`;
const TOTAL = "Total,350000,140000,140,100%,,";

describe("parseExhibitACsv", () => {
  it("parses the worked example", () => {
    const { rows, errors } = parseExhibitACsv(
      [HEADER, JANE, ACME, TOTAL].join("\n"),
      PRICE,
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      line: 2,
      name: "Jane Doe",
      committedCents: 25000000n,
      paidCents: 10000000n,
      admittedOn: "2026-11-13",
      receiptDate: "2026-11-13",
      email: "jane@example.com",
      streetAddress: "1 Main St, Frankfort, KY 40601",
      holderType: "INDIVIDUAL",
      isInsider: false,
      minimumWaived: false,
      holderTypeSupplied: false,
      isInsiderSupplied: false,
    });
    expect(rows[1]).toMatchObject({
      line: 3,
      committedCents: 10000000n,
      paidCents: 4000000n,
      admittedOn: "2026-11-16",
      email: "ops@acme.test",
      streetAddress: "2 Oak Ave, Cheyenne, WY 82001",
    });
  });

  it("reports a units mismatch on line 3", () => {
    const { rows, errors } = parseExhibitACsv(
      [HEADER, JANE, ACME.replace(",40,28", ",41,28"), TOTAL].join("\n"),
      PRICE,
    );
    expect(errors).toEqual([
      {
        line: 3,
        message:
          "Preferred Units 41 does not match Paid to Date $40,000.00 at $1,000.00 per unit (expected 40)",
      },
    ]);
    expect(rows).toHaveLength(1);
  });

  it("rejects paid > committed", () => {
    const { errors } = parseExhibitACsv(
      [HEADER, `Jane Doe,250000,300000,,,2026-11-13,jane@example.com`].join(
        "\n",
      ),
      PRICE,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
    expect(errors[0]?.message).toContain("more than the $250,000.00 committed");
  });

  it("rejects a duplicate email on the second row", () => {
    const { rows, errors } = parseExhibitACsv(
      [
        HEADER,
        JANE,
        `Jane Again,100000,40000,,,2026-11-13,JANE@example.com`,
      ].join("\n"),
      PRICE,
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      {
        line: 3,
        message: "The email jane@example.com is also used on line 2.",
      },
    ]);
  });

  it("rejects a file without Date Admitted", () => {
    const { rows, errors } = parseExhibitACsv(
      [
        "Member,Capital Contribution Committed,Paid to Date,Notice Address and Email",
        "Jane Doe,250000,100000,jane@example.com",
      ].join("\n"),
      PRICE,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 1, message: 'The column "Date Admitted" is missing.' },
    ]);
  });

  it("rejects an impossible date", () => {
    const { rows, errors } = parseExhibitACsv(
      [HEADER, JANE.replace("11/13/2026", "13/45/2026")].join("\n"),
      PRICE,
    );
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
    expect(errors[0]?.message).toContain("13/45/2026");
  });

  it("is strict about dates", () => {
    expect(parseExhibitADate("2026-02-29")).toBeNull();
    expect(parseExhibitADate("2/29/2028")).toBe("2028-02-29");
    expect(parseExhibitADate("2026-11-1")).toBeNull();
    expect(parseExhibitADate("11-13-2026")).toBeNull();
  });

  it("matches headers case-insensitively and handles BOM, CRLF, blank lines and quoted newlines", () => {
    const text = `﻿${HEADER.toLowerCase()}\r\n${JANE}\r\n\r\nAcme Holdings LLC,100000,40000,40,,2026-11-16,"2 Oak Ave\r\nCheyenne; ops@acme.test"\r\nBad Row,abc,1,,,2026-11-16,bad@x.test\r\n`;
    const { rows, errors } = parseExhibitACsv(text, PRICE);
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(6);
  });

  it("reports unquoted commas, bad yes/no and unknown columns", () => {
    const extra = parseExhibitACsv(
      [
        HEADER,
        `Jane Doe,$250,000.00,100000,,,2026-11-13,jane@example.com`,
      ].join("\n"),
      PRICE,
    );
    expect(extra.rows).toEqual([]);
    expect(extra.errors.some((e) => e.message.includes("double quotes"))).toBe(
      true,
    );

    const yesNo = parseExhibitACsv(
      [`${HEADER},Insider`, `${JANE},maybe`].join("\n"),
      PRICE,
    );
    expect(yesNo.errors).toEqual([
      { line: 2, message: '"Insider" "maybe" must be yes or no.' },
    ]);

    const unknown = parseExhibitACsv(
      [`${HEADER},Reciept Date`, `${JANE},2026-11-13`].join("\n"),
      PRICE,
    );
    expect(unknown.errors[0]?.line).toBe(1);
    expect(unknown.errors[0]?.message).toContain('"reciept date"');
  });

  it("uses the override columns and options", () => {
    const { rows, errors } = parseExhibitACsv(
      [
        "Member,Capital Contribution Committed,Paid to Date,Date Admitted,Email,Street Address,City,State,Zip,Holder Type,Signer Name,Insider,Minimum Waived,Receipt Date,Wire Reference",
        "Acme Trust,75000,30000,2026-11-05,Ops@Acme.test,9 Elm,Casper,wy,82601,Trust,Ann Lee,yes,yes,2026-11-04,W-1",
      ].join("\n"),
      PRICE,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      email: "ops@acme.test",
      streetAddress: "9 Elm",
      state: "WY",
      holderType: "TRUST",
      signerName: "Ann Lee",
      isInsider: true,
      minimumWaived: true,
      receiptDate: "2026-11-04",
      wireReference: "W-1",
      holderTypeSupplied: true,
      isInsiderSupplied: true,
    });
  });

  it("requires a signer for an entity and limits to 100 rows", () => {
    const signer = parseExhibitACsv(
      [`${HEADER},Holder Type`, `${JANE},entity`].join("\n"),
      PRICE,
    );
    expect(signer.errors[0]?.message).toContain("Signer Name is required");

    const many = [HEADER];
    for (let i = 0; i < 101; i++) {
      many.push(`M${i},100000,40000,,,2026-11-05,m${i}@x.test`);
    }
    const big = parseExhibitACsv(many.join("\n"), PRICE);
    expect(big.rows).toEqual([]);
    expect(big.errors).toHaveLength(1);
    expect(big.errors[0]?.line).toBe(1);
  });

  it("template parses back to one valid row", () => {
    const { rows, errors } = parseExhibitACsv(exhibitATemplateCsv(), PRICE);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});
