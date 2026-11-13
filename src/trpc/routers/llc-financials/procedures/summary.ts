import { economicsToday } from "@/server/llc/economics/clock";
import { getFinancialSummary } from "@/server/llc/economics/financials";
import { toWire } from "@/server/llc/economics/wire";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZAsOfSchema } from "../schema";

export const summaryProcedure = withLlcAccessControl
  .meta({ policies: { "llc-financials": { allow: ["read"] } } })
  .input(ZAsOfSchema)
  .query(async ({ ctx, input }) => {
    const asOf = input.asOf ?? economicsToday(ctx.company.timezone);
    return toWire(
      await getFinancialSummary(ctx.db, ctx.membership.companyId, asOf),
    );
  });
