import { TAG } from "../tags";

// Books and records (03-governance.md G18; Operating Agreement Section 8.1,
// rule R28). Pure: no database, no `@/` imports, so it is unit-tested and the
// UI may import it.
//
// The six categories are the values of the Prisma enum
// `BooksRecordCategoryEnum`; they are repeated here as a literal tuple so this
// module stays free of the generated client. The router checks at compile
// time that the two agree.

export const BOOKS_CATEGORY_KEYS = [
  "MEMBER_LIST",
  "ARTICLES_AND_AGREEMENT",
  "TAX_RETURNS",
  "FINANCIAL_STATEMENTS",
  "CONSENTS_AND_MINUTES",
  "OTHER_STATUTORY",
] as const;
export type BooksCategory = (typeof BOOKS_CATEGORY_KEYS)[number];

/**
 * How a category's completeness is judged:
 * - LIVE: the live Members register is the record; filed copies are extra.
 * - ANY_DOCUMENT: complete when at least one document is filed.
 * - PER_YEAR: one row per required fiscal year, present or missing.
 * - COUNT: no completeness rule; the number of documents only.
 */
export type BooksRule = "LIVE" | "ANY_DOCUMENT" | "PER_YEAR" | "COUNT";

export interface BooksCategoryDef {
  category: BooksCategory;
  label: string;
  section: string;
  rule: BooksRule;
}

/** In the order of Section 8.1 (and of the page). */
export const BOOKS_CATEGORIES: readonly BooksCategoryDef[] = [
  {
    category: "MEMBER_LIST",
    label: "Member list (names, addresses, Capital Contributions, Units)",
    section: "8.1(a)",
    rule: "LIVE",
  },
  {
    category: "ARTICLES_AND_AGREEMENT",
    label: "Articles of Organization, Operating Agreement and amendments",
    section: "8.1(b)",
    rule: "ANY_DOCUMENT",
  },
  {
    category: "TAX_RETURNS",
    label:
      "Federal, state and local tax or information returns (six fiscal years)",
    section: "8.1(c)",
    rule: "PER_YEAR",
  },
  {
    category: "FINANCIAL_STATEMENTS",
    label: "Financial statements (six fiscal years)",
    section: "8.1(d)",
    rule: "PER_YEAR",
  },
  {
    category: "CONSENTS_AND_MINUTES",
    label: "Minutes, written consents, waivers of notice, Member votes",
    section: "8.1(e)",
    rule: "COUNT",
  },
  {
    category: "OTHER_STATUTORY",
    label: "Other records required by the Wyoming LLC Act",
    section: "8.1(f)",
    rule: "COUNT",
  },
];

export function booksCategoryDef(category: BooksCategory): BooksCategoryDef {
  const def = BOOKS_CATEGORIES.find((c) => c.category === category);
  if (!def) throw new Error(`Unknown books category ${category}`);
  return def;
}

/** Tax returns and financial statements are kept per fiscal year. */
export function yearRequired(category: BooksCategory): boolean {
  return booksCategoryDef(category).rule === "PER_YEAR";
}

/**
 * The completed fiscal years whose records must be kept (Section 8.1(c),
 * (d): the past six fiscal years), from `max(formationYear, currentYear − 6)`
 * to `currentYear − 1`. Fiscal year = calendar year (Section 8.5).
 */
export function requiredFiscalYears(
  formationYear: number,
  currentYear: number,
): number[] {
  const years: number[] = [];
  for (
    let year = Math.max(formationYear, currentYear - 6);
    year <= currentYear - 1;
    year++
  ) {
    years.push(year);
  }
  return years;
}

/** A document is generated (filed by the app) when its bucket carries one of these tags. */
const GENERATED_TAGS: readonly string[] = [TAG.RESOLUTION, TAG.MEMBER_REPORT];

export function isGeneratedTags(tags: readonly string[]): boolean {
  return tags.some((tag) => GENERATED_TAGS.includes(tag));
}

export interface BooksDocumentLike {
  recordYear: number | null;
}

/** `Document.kind` of an executed Exhibit B signature page (F13, member documents). */
export const SIGNATURE_PAGE_KIND = "exhibit-b";

/**
 * The Section 8.1 category a document is kept under: the one it was filed
 * under, else 8.1(b) for an executed Exhibit B signature page. Section 8.1(b)
 * keeps "the Agreement with amendments"; a Member's signature page to
 * Exhibit B is its counterpart signature to the Agreement, so the executed
 * pages are part of that record.
 */
export function effectiveBooksCategory(document: {
  recordCategory: BooksCategory | null;
  kind: string | null;
}): BooksCategory | null {
  if (document.recordCategory !== null) return document.recordCategory;
  return document.kind === SIGNATURE_PAGE_KIND
    ? "ARTICLES_AND_AGREEMENT"
    : null;
}

export interface CategoryCompleteness {
  years: { year: number; present: boolean }[] | null;
  /** null: no completeness rule, or (per year) no fiscal year required yet */
  complete: boolean | null;
}

/** `years` and `complete` of one category's card. */
export function categoryCompleteness(
  category: BooksCategory,
  documents: readonly BooksDocumentLike[],
  requiredYears: readonly number[],
): CategoryCompleteness {
  const rule = booksCategoryDef(category).rule;
  if (rule === "ANY_DOCUMENT") {
    return { years: null, complete: documents.length > 0 };
  }
  if (rule === "PER_YEAR") {
    const filed = new Set(documents.map((d) => d.recordYear));
    const years = requiredYears.map((year) => ({
      year,
      present: filed.has(year),
    }));
    // No completed fiscal year yet: nothing is required, which is not
    // "Complete" either.
    if (years.length === 0) return { years, complete: null };
    return { years, complete: years.every((y) => y.present) };
  }
  return { years: null, complete: null };
}

/** The completeness chip of a card. */
export function completenessLabel(
  category: BooksCategory,
  completeness: CategoryCompleteness,
  documentCount: number,
): string {
  const rule = booksCategoryDef(category).rule;
  if (rule === "LIVE") return "Live register";
  if (rule === "COUNT") {
    return `${documentCount} ${documentCount === 1 ? "document" : "documents"}`;
  }
  if (rule === "PER_YEAR" && completeness.years?.length === 0) {
    return "Nothing required yet";
  }
  if (completeness.complete) return "Complete";
  if (rule === "PER_YEAR" && completeness.years) {
    const missing = completeness.years
      .filter((y) => !y.present)
      .map((y) => y.year);
    return `Missing ${missing.join(", ")}`;
  }
  return "Missing";
}

export interface CategorizeRequest {
  current: { recordCategory: BooksCategory | null; generated: boolean };
  recordCategory: BooksCategory | null;
  recordYear: number | null;
}

/**
 * Validates `books.categorize`. Returns the values to store, or the reason
 * the change is refused (BAD_REQUEST). Removing a document from its category
 * also clears its year.
 */
export function validateCategorize(request: CategorizeRequest):
  | {
      ok: true;
      recordCategory: BooksCategory | null;
      recordYear: number | null;
    }
  | { ok: false; message: string } {
  const { current, recordCategory } = request;
  if (current.generated) {
    return {
      ok: false,
      message:
        "Documents filed by the app cannot be moved or removed from the books and records (Section 8.1).",
    };
  }
  if (recordCategory === null) {
    return { ok: true, recordCategory: null, recordYear: null };
  }
  if (yearRequired(recordCategory) && request.recordYear === null) {
    return {
      ok: false,
      message: `${booksCategoryDef(recordCategory).label} are kept per fiscal year: choose the year the document relates to (Section ${booksCategoryDef(recordCategory).section}).`,
    };
  }
  return { ok: true, recordCategory, recordYear: request.recordYear };
}
