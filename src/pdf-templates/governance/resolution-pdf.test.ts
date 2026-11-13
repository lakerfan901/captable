import { describe, expect, it } from "vitest";
import { type ResolutionPdfData, renderResolutionPdf } from "./resolution-pdf";

const HASH = "3f9a1c0e5b7d2a4468e0c1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6";

// (a) Purchase-order resolution: Manager only, no ballots, no tally.
const PO: ResolutionPdfData = {
  companyName: "ACME COMPUTE LLC",
  kindLabel: "Written Resolution of the Manager",
  title: "Purchase order: 8 GPU servers from Example Systems Inc.",
  referenceCode: "R-2026-004",
  frozenHash: HASH,
  facts: {
    reference: "R-2026-004",
    recordDate: "March 2, 2026",
    sent: "March 2, 2026 9:15 AM MST",
    effective: "March 2, 2026 9:15 AM MST",
  },
  doc: [
    { t: "h", level: 1, inlines: [{ text: "Recitals" }] },
    {
      t: "p",
      indent: 0,
      inlines: [
        { text: "The Manager has reviewed " },
        { text: "three", bold: true },
        { text: " vendor quotes (" },
        { text: "see quote", href: "https://example.com/quote" },
        { text: ")." },
      ],
    },
    {
      t: "li",
      indent: 0,
      marker: "number",
      number: 1,
      inlines: [{ text: "Price at vendor cost", italic: true }],
    },
    {
      t: "li",
      indent: 1,
      marker: "check",
      checked: true,
      inlines: [{ text: "No markup", underline: true }],
    },
    {
      t: "li",
      indent: 0,
      marker: "bullet",
      inlines: [{ text: "code", code: true }],
    },
    { t: "quote", inlines: [{ text: "Quoted text", strike: true }] },
    { t: "hr" },
  ],
  lockedClauses: [
    "RESOLVED, that the purchase order is approved at vendor cost without markup.",
    "Approval required: the approval of the Manager.",
  ],
  approvals: [
    {
      role: "Manager",
      approverName: "Jane Manager",
      approverCapacity: "Managing Member of the Manager",
      signedAt: "March 2, 2026 9:15 AM MST",
    },
  ],
  hasBallots: "no",
  memberSignatures: [],
  tallies: [],
};

// (b) G1 case 29: amendment, Manager + Preferred Supermajority + Disinterested 70%.
const AMENDMENT: ResolutionPdfData = {
  companyName: "ACME COMPUTE LLC",
  kindLabel: "Action by Written Consent of the Members",
  title: "Amendment of the Operating Agreement",
  referenceCode: "R-2026-007",
  frozenHash: HASH,
  facts: {
    reference: "R-2026-007",
    recordDate: "April 1, 2026",
    sent: "April 1, 2026 10:00 AM MDT",
    effective: "April 9, 2026 4:30 PM MDT",
  },
  doc: [
    {
      t: "p",
      indent: 0,
      inlines: [
        { text: "The Members consent to amend Section 4.6 as follows." },
      ],
    },
  ],
  lockedClauses: [
    "RESOLVED, that the Operating Agreement is amended as set out above.",
    "Approval required: the approval of the Manager; the holders of at least 70% of the outstanding Preferred Units; the holders of at least 70% of the outstanding Disinterested Preferred Units.",
  ],
  approvals: [
    {
      role: "Manager",
      approverName: "Jane Manager",
      approverCapacity: "Managing Member of the Manager",
      signedAt: "April 1, 2026 10:00 AM MDT",
    },
  ],
  hasBallots: "yes",
  memberSignatures: [
    {
      member: "Alice",
      signedName: "Alice Example",
      signerCapacity: "",
      preferredUnits: "300",
      signedAt: "April 2, 2026 8:00 AM MDT",
    },
    {
      member: "Bob",
      signedName: "Bob Example",
      signerCapacity: "Trustee",
      preferredUnits: "100",
      signedAt: "April 3, 2026 8:00 AM MDT",
    },
    {
      member: "Schoen",
      signedName: "Schoen Example",
      signerCapacity: "",
      preferredUnits: "400",
      signedAt: "April 9, 2026 4:30 PM MDT",
    },
  ],
  tallies: [
    {
      basisLabel: "Preferred Supermajority",
      section: "12.1(c)",
      outstanding: "1,050",
      requiredUnits: "735",
      requiredWording:
        "the holders of at least 70% of the outstanding Preferred Units",
      forUnits: "800",
      forPercent: "76.19",
      against: "0",
      abstain: "0",
      noResponse: "250",
      deemedAgainst: "",
      result: "Approved",
    },
    {
      basisLabel: "70% of the Disinterested Preferred Units",
      section: "12.1(c)",
      outstanding: "900.5",
      requiredUnits: "630.35",
      requiredWording:
        "the holders of at least 70% of the outstanding Disinterested Preferred Units",
      forUnits: "700",
      forPercent: "77.73",
      against: "0",
      abstain: "0",
      noResponse: "200.5",
      deemedAgainst: "",
      result: "Approved",
    },
  ],
};

describe("renderResolutionPdf", () => {
  it.each([
    ["purchase-order resolution", PO],
    ["G1 case-29 amendment", AMENDMENT],
  ])(
    "renders the %s to a PDF buffer",
    async (_label, data) => {
      const buffer = await renderResolutionPdf(data);
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(buffer.byteLength).toBeGreaterThan(1024);
    },
    30_000,
  );
});
