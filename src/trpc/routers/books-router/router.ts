import { createTRPCRouter } from "@/trpc/api/trpc";
import { categorizeProcedure } from "./procedures/categorize";
import { overviewProcedure } from "./procedures/overview";
import { uncategorizedProcedure } from "./procedures/uncategorized";

// Books and records (03-governance.md G18, Operating Agreement Section 8.1).
// `withLlcAccessControl` with the `documents` RBAC subject (the G18 table);
// `companyId` always comes from the session's membership.
export const booksRouter = createTRPCRouter({
  overview: overviewProcedure,
  uncategorized: uncategorizedProcedure,
  categorize: categorizeProcedure,
});
