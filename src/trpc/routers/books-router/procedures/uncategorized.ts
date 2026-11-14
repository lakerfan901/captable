import { SIGNATURE_PAGE_KIND } from "@/lib/governance/books-core";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZBooksUncategorizedSchema } from "../schema";

// books.uncategorized (03-governance.md G18): up to 50 of the company's
// documents that are not filed under any Section 8.1 category, newest first,
// optionally filtered by name (case-insensitive).

export const uncategorizedProcedure = withLlcAccessControl
  .meta({ policies: { documents: { allow: ["read"] } } })
  .input(ZBooksUncategorizedSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const search = input.search?.trim();
    const documents = await ctx.db.document.findMany({
      where: {
        companyId,
        recordCategory: null,
        // executed Exhibit B pages are already kept under 8.1(b)
        OR: [{ kind: null }, { kind: { not: SIGNATURE_PAGE_KIND } }],
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: {
        publicId: true,
        name: true,
        createdAt: true,
        bucket: { select: { mimeType: true } },
      },
    });
    return documents.map((d) => ({
      publicId: d.publicId,
      name: d.name,
      createdAt: d.createdAt,
      mimeType: d.bucket.mimeType,
    }));
  });
