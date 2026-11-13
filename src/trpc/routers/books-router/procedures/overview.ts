import type { BooksRecordCategoryEnum } from "@prisma/client";
import {
  BOOKS_CATEGORIES,
  type BooksCategory,
  categoryCompleteness,
  isGeneratedTags,
  requiredFiscalYears,
} from "@/lib/governance/books-core";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { withLlcAccessControl } from "@/trpc/api/trpc";

// books.overview (03-governance.md G18): every categorised document of the
// company grouped by its Section 8.1 category, with each category's
// completeness. Bucket keys are never returned: a document opens through the
// Documents preview page, which does its own tenant check.

// The pure module's literal keys and the Prisma enum must stay identical.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const categoriesMatchEnum: Same<BooksCategory, BooksRecordCategoryEnum> = true;
void categoriesMatchEnum;

export const overviewProcedure = withLlcAccessControl
  .meta({ policies: { documents: { allow: ["read"] } } })
  .query(async ({ ctx }) => {
    const companyId = ctx.membership.companyId;
    const [company, documents] = await Promise.all([
      ctx.db.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { incorporationDate: true },
      }),
      ctx.db.document.findMany({
        where: { companyId, recordCategory: { not: null } },
        orderBy: [
          { recordYear: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        select: {
          publicId: true,
          bucketId: true,
          name: true,
          recordCategory: true,
          recordYear: true,
          createdAt: true,
          bucket: { select: { tags: true } },
        },
      }),
    ]);

    // Calendar dates are stored at UTC midnight; fiscal year = calendar year (8.5).
    const formationYear = company.incorporationDate.getUTCFullYear();
    const currentYear = Number(
      todayInZone(
        new Date(),
        ctx.company.timezone || GOVERNANCE_TIME_ZONE,
      ).slice(0, 4),
    );
    const required = requiredFiscalYears(formationYear, currentYear);

    const categories = BOOKS_CATEGORIES.map((def) => {
      const docs = documents
        .filter((d) => d.recordCategory === def.category)
        .map((d) => ({
          publicId: d.publicId,
          bucketId: d.bucketId,
          name: d.name,
          recordYear: d.recordYear,
          createdAt: d.createdAt,
          generated: isGeneratedTags(d.bucket.tags),
        }));
      const { years, complete } = categoryCompleteness(
        def.category,
        docs,
        required,
      );
      return {
        category: def.category,
        label: def.label,
        section: def.section,
        documents: docs,
        years,
        complete,
      };
    });

    return { categories };
  });
