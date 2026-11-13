import { TRPCError } from "@trpc/server";
import {
  type BooksCategory,
  booksCategoryDef,
  isGeneratedTags,
  validateCategorize,
} from "@/lib/governance/books-core";
import { Audit } from "@/server/audit";
import { guardedUpdate } from "@/server/guarded-write";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { boundRequestMeta } from "../../ballot-router/access";
import { ZBooksCategorizeSchema } from "../schema";

// books.categorize (03-governance.md G18): files a document of the company
// under a Section 8.1 category (with the fiscal year for tax returns and
// financial statements), moves it, or removes it from its category. Documents
// the app filed itself (resolution and member-report PDFs) cannot be moved or
// removed. One single-row update scoped to the company.

function notFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Document not found." });
}

function describe(category: BooksCategory | null, year: number | null): string {
  if (category === null) return "no category";
  return `Section ${booksCategoryDef(category).section}${
    year === null ? "" : ` (${year})`
  }`;
}

export const categorizeProcedure = withLlcAccessControl
  .meta({ policies: { documents: { allow: ["update"] } } })
  .input(ZBooksCategorizeSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const document = await tx.document.findFirst({
        where: { publicId: input.documentPublicId, companyId },
        select: {
          id: true,
          name: true,
          recordCategory: true,
          recordYear: true,
          bucket: { select: { tags: true } },
        },
      });
      if (!document) notFound();

      const result = validateCategorize({
        current: {
          recordCategory: document.recordCategory,
          generated: isGeneratedTags(document.bucket.tags),
        },
        recordCategory: input.recordCategory,
        recordYear: input.recordYear,
      });
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
      }

      const updated = await guardedUpdate(() =>
        tx.document.update({
          where: { id: document.id, companyId },
          data: {
            recordCategory: result.recordCategory,
            recordYear: result.recordYear,
          },
          select: { publicId: true, recordCategory: true, recordYear: true },
        }),
      );
      if (!updated) notFound();

      const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
      await Audit.create(
        {
          action: "document.categorized",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: meta.ip, userAgent: meta.userAgent },
          target: [{ type: "document", id: document.id }],
          summary: `${ctx.session.user.name ?? "A user"} filed "${
            document.name
          }" under ${describe(
            result.recordCategory,
            result.recordYear,
          )} of the books and records (was ${describe(
            document.recordCategory,
            document.recordYear,
          )})`,
        },
        tx,
      );

      return updated;
    });
  });
