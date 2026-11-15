// financialDashboard.status (04-investor-portal.md 5.9 "Procedures", P39;
// package P13b).
//
// `{ snapshotThrough, booksClosedThrough, drift }`. `drift` lists the
// published months whose snapshots differ from the ledger today, comparing
// the fund record AND every holder record exactly as `restateSnapshots`
// does, so a month is in the drift exactly when a Restate of it would
// rewrite it. Each entry: the fund fields that differ, the holders whose own
// record differs (id, name, fields), and the published and ledger fund
// records for the Restate dialog. Snapshots and ledger are read in one
// REPEATABLE READ transaction (a release committing meanwhile is either
// wholly seen or not at all).

import { Prisma } from "@prisma/client";
import { financialStatus } from "@/server/llc/economics/financial-dashboard";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const statusProcedure = withLlcAccessControl
  .meta({ policies: { "llc-financials": { allow: ["read"] } } })
  .query(({ ctx }) =>
    ctx.db.$transaction((tx) => financialStatus(tx, ctx.membership.companyId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10_000,
      timeout: 60_000,
    }),
  );
