import { describe, expect, it } from "vitest";
import {
  canShareWith,
  documentShareability,
  isDocumentVisible,
  normalizePortalEmail,
  shareRefusals,
} from "./visibility-core";

describe("documentShareability (P14)", () => {
  it("is ANY only for an explicit null", () => {
    expect(documentShareability({ stakeholderId: null })).toEqual({
      kind: "ANY",
    });
  });

  it("is HOLDER_ONLY for any string, the empty string included", () => {
    expect(documentShareability({ stakeholderId: "holder-a" })).toEqual({
      kind: "HOLDER_ONLY",
      stakeholderId: "holder-a",
    });
    expect(documentShareability({ stakeholderId: "" })).toEqual({
      kind: "HOLDER_ONLY",
      stakeholderId: "",
    });
  });

  it("throws when the field was not selected", () => {
    expect(() => documentShareability({} as { stakeholderId: null })).toThrow(
      TypeError,
    );
    expect(() =>
      documentShareability({ stakeholderId: 5 as unknown as string }),
    ).toThrow(TypeError);
  });

  it("canShareWith: a W-9 of A only with A", () => {
    const w9 = { stakeholderId: "A" };
    expect(canShareWith(w9, "A")).toBe(true);
    expect(canShareWith(w9, "B")).toBe(false);
    expect(canShareWith(w9, "a")).toBe(false);
    expect(canShareWith(w9, " A")).toBe(false);
    expect(canShareWith({ stakeholderId: null }, "B")).toBe(true);
    expect(canShareWith({ stakeholderId: "" }, "")).toBe(true);
    expect(canShareWith({ stakeholderId: "" }, "B")).toBe(false);
  });
});

describe("shareRefusals (all-or-nothing)", () => {
  const docs = [
    { id: "d-free", stakeholderId: null },
    { id: "d-w9-a", stakeholderId: "A" },
  ];
  const holders = ["A", "B", "C"];

  it("is empty for a valid share", () => {
    expect(shareRefusals(["d-free"], ["A", "C"], docs, holders)).toEqual([]);
    expect(shareRefusals(["d-free", "d-w9-a"], ["A"], docs, holders)).toEqual(
      [],
    );
  });

  it("refuses a holder-bound document for another holder, naming the pair", () => {
    expect(
      shareRefusals(["d-free", "d-w9-a"], ["A", "B"], docs, holders),
    ).toEqual([
      { documentId: "d-w9-a", stakeholderId: "B", code: "HOLDER_ONLY" },
    ]);
  });

  it("refuses unknown documents and foreign holders", () => {
    expect(shareRefusals(["d-other-company"], ["A"], docs, holders)).toEqual([
      {
        documentId: "d-other-company",
        stakeholderId: "",
        code: "UNKNOWN_DOCUMENT",
      },
    ]);
    expect(shareRefusals(["d-free"], ["F"], docs, holders)).toEqual([
      { documentId: "d-free", stakeholderId: "F", code: "UNKNOWN_HOLDER" },
    ]);
  });

  it("checks duplicated ids once", () => {
    expect(
      shareRefusals(["d-w9-a", "d-w9-a"], ["B", "B"], docs, holders),
    ).toEqual([
      { documentId: "d-w9-a", stakeholderId: "B", code: "HOLDER_ONLY" },
    ]);
  });

  it("treats prototype names as plain ids", () => {
    expect(
      shareRefusals(["__proto__"], ["constructor"], docs, holders),
    ).toEqual([
      { documentId: "__proto__", stakeholderId: "", code: "UNKNOWN_DOCUMENT" },
    ]);
    expect(
      shareRefusals(["d-free"], ["__proto__", "toString"], docs, holders),
    ).toHaveLength(2);
  });
});

describe("isDocumentVisible (read side)", () => {
  const grants = new Set(["d-free", "d-w9-a"]);

  it("needs a grant", () => {
    expect(
      isDocumentVisible({ id: "d-free", stakeholderId: null }, grants, "B"),
    ).toBe(true);
    expect(
      isDocumentVisible({ id: "d-none", stakeholderId: null }, grants, "B"),
    ).toBe(false);
  });

  it("ignores a hand-inserted grant on another holder's document", () => {
    expect(
      isDocumentVisible({ id: "d-w9-a", stakeholderId: "A" }, grants, "B"),
    ).toBe(false);
    expect(
      isDocumentVisible({ id: "d-w9-a", stakeholderId: "A" }, grants, "A"),
    ).toBe(true);
  });

  it("an empty grant set shows nothing", () => {
    expect(
      isDocumentVisible({ id: "d-free", stakeholderId: null }, new Set(), "A"),
    ).toBe(false);
  });
});

describe("normalizePortalEmail", () => {
  it.each([
    ["a@x.test", "a@x.test"],
    ["  JSmith@Example.COM ", "jsmith@example.com"],
    ["first.last+tag@sub.example.co.uk", "first.last+tag@sub.example.co.uk"],
    ["o'brien@x.test", "o'brien@x.test"],
    // NFC: e + combining acute becomes \u00e9.
    ["re\u0301ne@x.test", "r\u00e9ne@x.test"],
  ])("normalises %s", (raw, expected) => {
    expect(normalizePortalEmail(raw)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 5],
    ["empty", ""],
    ["spaces", "   "],
    ["no at", "jsmith.example.com"],
    ["two ats", "a@b@x.test"],
    ["empty local", "@x.test"],
    ["empty domain", "a@"],
    ["no dot in domain", "a@localhost"],
    ["empty label", "a@x..test"],
    ["leading dot domain", "a@.x.test"],
    ["trailing dot domain", "a@x.test."],
    ["hyphen label", "a@-x.test"],
    ["leading dot local", ".a@x.test"],
    ["trailing dot local", "a.@x.test"],
    ["double dot local", "a..b@x.test"],
    ["inner space", "a b@x.test"],
    ["a tab", "a\t@x.test"],
    ["a newline (header injection)", "a@x.test\nBcc: b@x.test"],
    ["NUL", "a\u0000@x.test"],
    ["angle brackets", "<a@x.test>"],
    ["a display name", "A <a@x.test>"],
    ["a comma list", "a@x.test,b@x.test"],
    ["a semicolon list", "a@x.test;b@x.test"],
    ["quotes", '"a"@x.test'],
    ["a backslash", "a\\b@x.test"],
    ["a lone surrogate", "a\ud800@x.test"],
    ["65-character local", `${"a".repeat(65)}@x.test`],
    [
      "over 254 characters",
      `a@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(70)}.test`,
    ],
    ["a 64-character label", `a@${"b".repeat(64)}.test`],
  ])("refuses %s", (_label, raw) => {
    expect(normalizePortalEmail(raw)).toBeNull();
  });

  it("accepts a 64-character local part and 254 characters in total", () => {
    const local = "a".repeat(64);
    expect(normalizePortalEmail(`${local}@x.test`)).toBe(`${local}@x.test`);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(60)}`;
    const email = `a@${domain}`;
    expect(email).toHaveLength(254);
    expect(normalizePortalEmail(email)).toBe(email);
    expect(normalizePortalEmail(`a${email}`)).toBeNull();
  });

  it("is idempotent", () => {
    for (const raw of ["  A@X.TEST", "re\u0301ne@x.test", "x+y@a.b.c"]) {
      const once = normalizePortalEmail(raw);
      expect(normalizePortalEmail(once)).toBe(once);
    }
  });
});
