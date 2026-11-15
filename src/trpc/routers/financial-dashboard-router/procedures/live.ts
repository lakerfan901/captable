// financialDashboard.live (04-investor-portal.md 5.9 "Procedures", P39;
// package P13b).
//
// The team's dashboard computed now from the ledger: every month from the
// ledger's inception through the month of `through` (default and maximum:
// the economics "today"), the current month marked `inProgress`. Same shape
// as `portal.financials.get`, `holderMonths` and `restatements` empty;
// `publishedThrough` is the date the last month's figures are taken at
// (`asOf`). Read in one REPEATABLE READ transaction, so the months are one
// consistent state of the ledger.

import { Prisma } from "@prisma/client";
import { liveFinancialView } from "@/server/llc/economics/financial-dashboard";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZLiveInput } from "../schema";

export const liveProcedure = withLlcAccessControl
  .meta({ policies: { "llc-financials": { allow: ["read"] } } })
  .input(ZLiveInput)
  .query(({ ctx, input }) =>
    ctx.db.$transaction(
      (tx) =>
        liveFinancialView(tx, ctx.membership.companyId, ctx.company, {
          through: input?.through,
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 60_000,
      },
    ),
  );
