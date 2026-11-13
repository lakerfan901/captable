import { z } from "zod";
import { BOOKS_CATEGORY_KEYS } from "@/lib/governance/books-core";

// Inputs of the books-and-records router (03-governance.md G18). Client-safe:
// zod and the pure books module only.

export const ZBooksRecordCategory = z.enum(BOOKS_CATEGORY_KEYS);

export const ZBooksUncategorizedSchema = z
  .object({ search: z.string().trim().max(100).optional() })
  .strict();

export const ZBooksCategorizeSchema = z
  .object({
    documentPublicId: z.string().trim().min(1).max(64),
    recordCategory: ZBooksRecordCategory.nullable(),
    recordYear: z.number().int().min(2000).max(2100).nullable(),
  })
  .strict();
