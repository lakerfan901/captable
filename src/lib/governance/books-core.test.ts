import { describe, expect, test } from "vitest";
import {
  BOOKS_CATEGORIES,
  BOOKS_CATEGORY_KEYS,
  categoryCompleteness,
  completenessLabel,
  isGeneratedTags,
  requiredFiscalYears,
  validateCategorize,
  yearRequired,
} from "./books-core";

describe("requiredFiscalYears", () => {
  test("no completed fiscal year in the formation year", () => {
    expect(requiredFiscalYears(2026, 2026)).toEqual([]);
  });

  test("the formation year once it is completed", () => {
    expect(requiredFiscalYears(2026, 2027)).toEqual([2026]);
  });

  test("only the past six fiscal years", () => {
    expect(requiredFiscalYears(2026, 2035)).toEqual([
      2029, 2030, 2031, 2032, 2033, 2034,
    ]);
  });
});

describe("BOOKS_CATEGORIES", () => {
  test("the six 8.1 categories in section order", () => {
    expect(BOOKS_CATEGORIES.map((c) => c.category)).toEqual([
      ...BOOKS_CATEGORY_KEYS,
    ]);
    expect(BOOKS_CATEGORIES.map((c) => c.section)).toEqual([
      "8.1(a)",
      "8.1(b)",
      "8.1(c)",
      "8.1(d)",
      "8.1(e)",
      "8.1(f)",
    ]);
  });

  test("a year is required for tax returns and financial statements only", () => {
    expect(BOOKS_CATEGORY_KEYS.filter((c) => yearRequired(c))).toEqual([
      "TAX_RETURNS",
      "FINANCIAL_STATEMENTS",
    ]);
  });
});

describe("isGeneratedTags", () => {
  test("resolution and member-report buckets are generated", () => {
    expect(isGeneratedTags(["resolution"])).toBe(true);
    expect(isGeneratedTags(["member-report"])).toBe(true);
    expect(isGeneratedTags(["generic"])).toBe(false);
    expect(isGeneratedTags([])).toBe(false);
  });
});

describe("categoryCompleteness", () => {
  test("member list is the live register", () => {
    const c = categoryCompleteness("MEMBER_LIST", [], [2026]);
    expect(c).toEqual({ years: null, complete: null });
    expect(completenessLabel("MEMBER_LIST", c, 0)).toBe("Live register");
  });

  test("articles and agreement are complete with one document", () => {
    const empty = categoryCompleteness("ARTICLES_AND_AGREEMENT", [], []);
    expect(empty).toEqual({ years: null, complete: false });
    expect(completenessLabel("ARTICLES_AND_AGREEMENT", empty, 0)).toBe(
      "Missing",
    );
    const one = categoryCompleteness(
      "ARTICLES_AND_AGREEMENT",
      [{ recordYear: null }],
      [],
    );
    expect(one.complete).toBe(true);
    expect(completenessLabel("ARTICLES_AND_AGREEMENT", one, 1)).toBe(
      "Complete",
    );
  });

  test("financial statements per required year", () => {
    const c = categoryCompleteness(
      "FINANCIAL_STATEMENTS",
      [{ recordYear: 2030 }, { recordYear: 2030 }, { recordYear: 2025 }],
      requiredFiscalYears(2026, 2032),
    );
    expect(c.years).toEqual([
      { year: 2026, present: false },
      { year: 2027, present: false },
      { year: 2028, present: false },
      { year: 2029, present: false },
      { year: 2030, present: true },
      { year: 2031, present: false },
    ]);
    expect(c.complete).toBe(false);
    expect(completenessLabel("FINANCIAL_STATEMENTS", c, 3)).toBe(
      "Missing 2026, 2027, 2028, 2029, 2031",
    );
  });

  test("tax returns complete when every required year is present", () => {
    const c = categoryCompleteness(
      "TAX_RETURNS",
      [{ recordYear: 2026 }],
      requiredFiscalYears(2026, 2027),
    );
    expect(c).toEqual({
      years: [{ year: 2026, present: true }],
      complete: true,
    });
    expect(completenessLabel("TAX_RETURNS", c, 1)).toBe("Complete");
  });

  test("no required year yet is complete", () => {
    const c = categoryCompleteness("TAX_RETURNS", [], []);
    expect(c).toEqual({ years: [], complete: true });
  });

  test("count-only categories", () => {
    const c = categoryCompleteness(
      "CONSENTS_AND_MINUTES",
      [{ recordYear: 2026 }, { recordYear: 2026 }],
      [2026],
    );
    expect(c).toEqual({ years: null, complete: null });
    expect(completenessLabel("CONSENTS_AND_MINUTES", c, 2)).toBe("2 documents");
    expect(completenessLabel("OTHER_STATUTORY", c, 1)).toBe("1 document");
  });
});

describe("validateCategorize", () => {
  const manual = { recordCategory: null, generated: false };

  test("files a manual document with a year", () => {
    expect(
      validateCategorize({
        current: manual,
        recordCategory: "FINANCIAL_STATEMENTS",
        recordYear: 2026,
      }),
    ).toEqual({
      ok: true,
      recordCategory: "FINANCIAL_STATEMENTS",
      recordYear: 2026,
    });
  });

  test("a year is required for tax returns and financial statements", () => {
    for (const recordCategory of [
      "TAX_RETURNS",
      "FINANCIAL_STATEMENTS",
    ] as const) {
      const result = validateCategorize({
        current: manual,
        recordCategory,
        recordYear: null,
      });
      expect(result.ok).toBe(false);
    }
    expect(
      validateCategorize({
        current: manual,
        recordCategory: "ARTICLES_AND_AGREEMENT",
        recordYear: null,
      }),
    ).toEqual({
      ok: true,
      recordCategory: "ARTICLES_AND_AGREEMENT",
      recordYear: null,
    });
  });

  test("removing from a category clears the year", () => {
    expect(
      validateCategorize({
        current: { recordCategory: "TAX_RETURNS", generated: false },
        recordCategory: null,
        recordYear: 2026,
      }),
    ).toEqual({ ok: true, recordCategory: null, recordYear: null });
  });

  test("generated documents cannot be moved or un-categorised", () => {
    const current = {
      recordCategory: "CONSENTS_AND_MINUTES" as const,
      generated: true,
    };
    expect(
      validateCategorize({ current, recordCategory: null, recordYear: null })
        .ok,
    ).toBe(false);
    expect(
      validateCategorize({
        current,
        recordCategory: "OTHER_STATUTORY",
        recordYear: 2026,
      }).ok,
    ).toBe(false);
  });
});
