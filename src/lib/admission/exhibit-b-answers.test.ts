import { describe, expect, it } from "vitest";
import states from "../states";
import { type ExhibitBField, mapExhibitBAnswers } from "./exhibit-b-answers";

const STATES = states.map((s) => ({ code: s.abbreviation, name: s.name }));
const TERMS = { minCommitmentCents: 10_000_000, initialInstallmentBps: 4000 };

const BASE: Record<string, string> = {
  commitment_amount: "$250,000",
  amount_paid: "100,000.00",
  accreditation_basis: "NET_WORTH",
  legal_name: "Jane Doe",
  holder_type: "INDIVIDUAL",
  residence_state: "kentucky",
  investment_summary_date: "2026-11-05",
  address_street: "1 Main St",
  address_city: "Frankfort",
  address_state: "KY",
  address_zip: "40601",
  email: " Jane@Example.com ",
  investor_sign_date: "2026-11-12",
};

/** Investor fields for every key of `answers` (an omitted key = no field). */
function fields(
  answers: Record<string, string | undefined>,
  role = "investor",
): ExhibitBField[] {
  return Object.entries(answers)
    .filter(([, v]) => v !== undefined)
    .map(([semanticKey, prefilledValue]) => ({
      semanticKey,
      prefilledValue: prefilledValue ?? null,
      role,
    }));
}

const map = (overrides: Record<string, string | undefined> = {}) =>
  mapExhibitBAnswers(fields({ ...BASE, ...overrides }), STATES, TERMS);

describe("mapExhibitBAnswers", () => {
  it("reads the worked example with no issues", () => {
    const { parsed, issues, raw } = map();
    expect(issues).toEqual([]);
    expect(parsed.committedCents).toBe(25_000_000);
    expect(parsed.paidCents).toBe(10_000_000);
    expect(parsed.residenceState).toBe("KY");
    expect(parsed.state).toBe("KY");
    expect(parsed.email).toBe("jane@example.com");
    expect(parsed.accreditationBasis).toBe("NET_WORTH");
    expect(parsed.holderType).toBe("INDIVIDUAL");
    expect(parsed.legalName).toBe("Jane Doe");
    expect(parsed.investmentSummaryDate).toBe("2026-11-05");
    expect(parsed.investorSignDate).toBe("2026-11-12");
    expect(parsed.streetAddress).toBe("1 Main St");
    expect(parsed.city).toBe("Frankfort");
    expect(parsed.zipcode).toBe("40601");
    expect(parsed.signerName).toBe("");
    expect(raw.email).toBe(" Jane@Example.com ");
  });

  it("flags a payment below the 40% Initial Installment", () => {
    const { parsed, issues } = map({ amount_paid: "99,999" });
    expect(parsed.paidCents).toBe(9_999_900);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      "Paid with the signature page is below the 40% Initial Installment (Section 4.9)",
    );
  });

  it("does not read a committed amount in words", () => {
    const { parsed, issues } = map({
      commitment_amount: "two hundred thousand",
    });
    expect(parsed.committedCents).toBeNull();
    expect(issues).toEqual([
      'Could not read the committed amount: "two hundred thousand"',
    ]);
  });

  it("flags a commitment below the minimum", () => {
    const { parsed, issues } = map({
      commitment_amount: "75000",
      amount_paid: "30000",
    });
    expect(parsed.committedCents).toBe(7_500_000);
    expect(issues).toEqual([
      "Below the minimum; a waiver is needed (Section 3.7)",
    ]);
  });

  it("splits the entity signer's name and title", () => {
    const { parsed, issues } = map({
      holder_type: "ENTITY",
      accreditation_basis: "ENTITY_ASSETS",
      signer_name_title: "Jane Doe, Managing Member",
    });
    expect(issues).toEqual([]);
    expect(parsed.holderType).toBe("ENTITY");
    expect(parsed.signerName).toBe("Jane Doe");
    expect(parsed.signerTitle).toBe("Managing Member");
  });

  it("flags an entity without a signer", () => {
    const { parsed, issues } = map({ holder_type: "ENTITY" });
    expect(parsed.signerName).toBe("");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("signer");
  });

  it("keeps a signer without a comma as a name only", () => {
    const { parsed } = map({
      holder_type: "TRUST",
      signer_name_title: "John Roe",
    });
    expect(parsed.signerName).toBe("John Roe");
    expect(parsed.signerTitle).toBe("");
  });

  it("refuses an accreditation basis that is not an option id", () => {
    const { parsed, issues } = map({ accreditation_basis: "something" });
    expect(parsed.accreditationBasis).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('"something"');
  });

  it("refuses an unknown state, a bad date and a bad email", () => {
    const { parsed, issues } = map({
      residence_state: "Atlantis",
      investment_summary_date: "2026-13-05",
      email: "jane at example",
    });
    expect(parsed.residenceState).toBeNull();
    expect(parsed.investmentSummaryDate).toBeNull();
    expect(parsed.email).toBeNull();
    expect(issues).toHaveLength(3);
  });

  it("ignores an answer on a field of the other role", () => {
    const answers = mapExhibitBAnswers(
      [
        ...fields(BASE),
        // A Manager-role field carrying an investor key never counts...
        {
          semanticKey: "commitment_amount",
          prefilledValue: "1",
          role: "manager",
        },
        // ...and an investor cannot fill the Manager's ledger lines.
        {
          semanticKey: "contribution_received",
          prefilledValue: "$9,999,999.00",
          role: "investor",
        },
      ],
      STATES,
      TERMS,
    );
    expect(answers.parsed.committedCents).toBe(25_000_000);
    expect(answers.raw.contribution_received).toBeUndefined();
    expect(answers.issues).toEqual([]);
  });

  it("lists the required answers that are missing", () => {
    const { parsed, issues } = map({
      commitment_amount: undefined,
      email: undefined,
    });
    expect(parsed.committedCents).toBeNull();
    expect(parsed.email).toBeNull();
    expect(issues).toEqual([
      "Not answered: Capital Contribution committed, Email",
    ]);
  });

  it("reports a key answered twice with different values", () => {
    const answers = mapExhibitBAnswers(
      [
        ...fields(BASE),
        {
          semanticKey: "legal_name",
          prefilledValue: "J. Doe",
          role: "investor",
        },
      ],
      STATES,
      TERMS,
    );
    expect(answers.parsed.legalName).toBe("Jane Doe");
    expect(answers.issues).toHaveLength(1);
    expect(answers.issues[0]).toContain("Legal name");
  });
});
