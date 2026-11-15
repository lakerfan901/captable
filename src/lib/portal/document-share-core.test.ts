import { describe, expect, it } from "vitest";
import {
  bindingRefusalMessage,
  bindingStakeholderId,
  decodeLogCursor,
  documentBinding,
  documentSource,
  encodeLogCursor,
  isHolderRemoved,
  missingCurrentMembers,
  NO_HOLDER,
  type SourceFacts,
  shareWarnings,
} from "./document-share-core";
import { isDocumentVisible, shareRefusals } from "./visibility-core";

describe("documentBinding (P14 over every tie)", () => {
  it("is ANY without ties", () => {
    expect(documentBinding({ ties: [], holderRemoved: false })).toEqual({
      kind: "ANY",
    });
  });

  it("is HOLDER_ONLY for one holder through any number of sources", () => {
    expect(
      documentBinding({
        ties: [
          { source: "DOCUMENT", stakeholderId: "A" },
          { source: "ESIGN_PACKET", stakeholderId: "A" },
          { source: "DOCUMENT", stakeholderId: "A" },
        ],
        holderRemoved: false,
      }),
    ).toEqual({
      kind: "HOLDER_ONLY",
      stakeholderId: "A",
      sources: ["DOCUMENT", "ESIGN_PACKET"],
    });
  });

  it("binds an untied Document that points at a W-9's object (SAME_FILE)", () => {
    const b = documentBinding({
      ties: [{ source: "SAME_FILE", stakeholderId: "A" }],
      holderRemoved: false,
    });
    expect(bindingStakeholderId(b)).toBe("A");
  });

  it("is NONE for two holders, and for a removed holder", () => {
    expect(
      documentBinding({
        ties: [
          { source: "DOCUMENT", stakeholderId: "A" },
          { source: "SECURITY", stakeholderId: "B" },
        ],
        holderRemoved: false,
      }),
    ).toEqual({ kind: "NONE", reason: "MULTIPLE_HOLDERS" });
    expect(documentBinding({ ties: [], holderRemoved: true })).toEqual({
      kind: "NONE",
      reason: "HOLDER_REMOVED",
    });
  });

  it("NONE refuses every holder in shareRefusals and isDocumentVisible", () => {
    const none = documentBinding({ ties: [], holderRemoved: true });
    const doc = { id: "d", stakeholderId: bindingStakeholderId(none) };
    expect(doc.stakeholderId).toBe(NO_HOLDER);
    expect(shareRefusals(["d"], ["A", "B"], [doc], ["A", "B"])).toEqual([
      { documentId: "d", stakeholderId: "A", code: "HOLDER_ONLY" },
      { documentId: "d", stakeholderId: "B", code: "HOLDER_ONLY" },
    ]);
    expect(isDocumentVisible(doc, new Set(["d"]), "A")).toBe(false);
  });

  it("isHolderRemoved: a member-page kind without a holder", () => {
    expect(isHolderRemoved({ kind: "w9", stakeholderId: null })).toBe(true);
    expect(isHolderRemoved({ kind: "other", stakeholderId: null })).toBe(true);
    expect(isHolderRemoved({ kind: "w9", stakeholderId: "A" })).toBe(false);
    expect(isHolderRemoved({ kind: null, stakeholderId: null })).toBe(false);
    expect(isHolderRemoved({ kind: "custom", stakeholderId: null })).toBe(
      false,
    );
  });
});

const facts = (over: Partial<SourceFacts> = {}): SourceFacts => ({
  name: "file.pdf",
  kind: null,
  recordCategory: null,
  tags: [],
  key: "co_1/generic-documents-file-abc.pdf",
  security: false,
  esignOutput: false,
  ...over,
});

describe("documentSource and shareWarnings (S6)", () => {
  it("classifies every source", () => {
    expect(documentSource(facts({ kind: "w9" }))).toBe("W9");
    expect(documentSource(facts({ kind: "exhibit-b" }))).toBe("EXHIBIT_B");
    expect(documentSource(facts({ kind: "other" }))).toBe("MEMBER_FILE");
    expect(documentSource(facts({ tags: ["resolution"] }))).toBe("RESOLUTION");
    expect(documentSource(facts({ key: "c/resolutions-x-1.pdf" }))).toBe(
      "RESOLUTION",
    );
    expect(documentSource(facts({ tags: ["member-report"] }))).toBe(
      "MEMBER_REPORT",
    );
    expect(documentSource(facts({ esignOutput: true }))).toBe("ESIGN");
    expect(documentSource(facts({ security: true }))).toBe("SECURITY_FILE");
    expect(
      documentSource(facts({ recordCategory: "FINANCIAL_STATEMENTS" })),
    ).toBe("FINANCIAL_STATEMENTS");
    expect(documentSource(facts({ key: "pub/data-room/room1-x-1.pdf" }))).toBe(
      "DATA_ROOM",
    );
    expect(documentSource(facts())).toBe("UPLOAD");
  });

  it("warns on member lists, resolutions, consents, report PDFs and signed files", () => {
    const codes = (f: SourceFacts) => shareWarnings(f).map((w) => w.code);
    expect(codes(facts({ recordCategory: "MEMBER_LIST" }))).toEqual([
      "MEMBER_LIST",
    ]);
    expect(codes(facts({ name: "Exhibit A 2026.pdf" }))).toEqual([
      "MEMBER_LIST",
    ]);
    expect(codes(facts({ name: "exhibit-a-co-2026-11-14.csv" }))).toEqual([
      "MEMBER_LIST",
    ]);
    expect(codes(facts({ name: "Exhibit B.pdf" }))).toEqual([]);
    expect(codes(facts({ name: "Exhibit AB.pdf" }))).toEqual([]);
    expect(
      codes(
        facts({ tags: ["resolution"], recordCategory: "CONSENTS_AND_MINUTES" }),
      ),
    ).toEqual(["RESOLUTION"]);
    expect(codes(facts({ recordCategory: "CONSENTS_AND_MINUTES" }))).toEqual([
      "CONSENTS",
    ]);
    expect(codes(facts({ tags: ["member-report"] }))).toEqual([
      "MEMBER_REPORT",
    ]);
    expect(codes(facts({ esignOutput: true }))).toEqual(["SIGNED_DOCUMENT"]);
    expect(codes(facts())).toEqual([]);
  });
});

describe("missingCurrentMembers (P28)", () => {
  const holders = [
    { stakeholderId: "A", isCurrentMember: true },
    { stakeholderId: "B", isCurrentMember: true },
    { stakeholderId: "P", isCurrentMember: false },
  ];

  it("names current Members not on the list", () => {
    expect(
      missingCurrentMembers({ kind: "ANY" }, holders, new Set(["A"])),
    ).toEqual({
      stakeholderIds: ["B"],
      message: "1 current Member is not on this list",
    });
    expect(missingCurrentMembers({ kind: "ANY" }, holders, new Set())).toEqual({
      stakeholderIds: ["A", "B"],
      message: "2 current Members are not on this list",
    });
    expect(
      missingCurrentMembers({ kind: "ANY" }, holders, new Set(["A", "B"])),
    ).toEqual({ stakeholderIds: [], message: null });
  });

  it("is empty for a holder-bound file", () => {
    expect(
      missingCurrentMembers(
        { kind: "HOLDER_ONLY", stakeholderId: "A", sources: ["DOCUMENT"] },
        holders,
        new Set(),
      ).stakeholderIds,
    ).toEqual([]);
  });
});

describe("bindingRefusalMessage", () => {
  it("names the rule", () => {
    expect(
      bindingRefusalMessage(
        "W-9.pdf",
        { kind: "HOLDER_ONLY", stakeholderId: "A", sources: ["DOCUMENT"] },
        "Alice",
      ),
    ).toMatch(/belongs to Alice and can be shared only with that holder/);
    expect(
      bindingRefusalMessage(
        "x.pdf",
        { kind: "NONE", reason: "MULTIPLE_HOLDERS" },
        null,
      ),
    ).toMatch(/more than one holder/);
  });
});

describe("log cursor", () => {
  it("round-trips and refuses anything else", () => {
    const row = { createdAt: new Date(1_763_000_000_123), id: "cm_abc-1" };
    expect(decodeLogCursor(encodeLogCursor(row))).toEqual(row);
    expect(decodeLogCursor("")).toBeNull();
    expect(decodeLogCursor("abc.def")).toBeNull();
    expect(decodeLogCursor("1.a b")).toBeNull();
    expect(decodeLogCursor("1.a.b")).toBeNull();
    expect(decodeLogCursor(`1.${"x".repeat(65)}`)).toBeNull();
  });
});
