import { describe, expect, it } from "vitest";
import {
  esignCompletedSubject,
  esignRequestCopy,
  STANDARD_COMPLETED_SUBJECT,
  STANDARD_REQUEST_SUBJECT,
} from "./email-copy";

describe("esignRequestCopy", () => {
  it("keeps the generic subject for an ordinary e-sign template", () => {
    const copy = esignRequestCopy({
      workflow: "STANDARD",
      companyName: "Acme LLC",
      senderName: "Jane",
    });
    expect(copy.subject).toBe("eSign Document Request");
    expect(copy.subject).toBe(STANDARD_REQUEST_SUBJECT);
    expect(copy.headline).toBeNull();
    expect(copy.intro).toBeNull();
    expect(copy.button).toBe("Sign the document");
  });

  it("names the company and the documents for a subscription packet", () => {
    const copy = esignRequestCopy({
      workflow: "SUBSCRIPTION",
      companyName: "  G19 Fund LLC ",
      senderName: "Gina",
    });
    expect(copy.subject).toBe(
      "G19 Fund LLC: your subscription documents to sign",
    );
    expect(copy.headline).toContain("G19 Fund LLC");
    expect(copy.intro).toContain("Exhibit B");
    expect(copy.intro).toContain("Form W-9");
  });

  it("falls back to the generic wording without a company name", () => {
    expect(
      esignRequestCopy({
        workflow: "SUBSCRIPTION",
        companyName: "",
        senderName: null,
      }).subject,
    ).toBe(STANDARD_REQUEST_SUBJECT);
    expect(
      esignRequestCopy({ workflow: null, companyName: "X", senderName: null })
        .subject,
    ).toBe(STANDARD_REQUEST_SUBJECT);
  });
});

describe("esignCompletedSubject", () => {
  it("keeps the generic subject for an ordinary template", () => {
    expect(
      esignCompletedSubject({ workflow: "STANDARD", companyName: "Acme" }),
    ).toBe(STANDARD_COMPLETED_SUBJECT);
  });

  it("names the company for a countersigned subscription", () => {
    expect(
      esignCompletedSubject({ workflow: "SUBSCRIPTION", companyName: "Acme" }),
    ).toBe("Acme: your subscription documents are countersigned");
  });
});
