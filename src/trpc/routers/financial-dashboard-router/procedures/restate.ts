// financialDashboard.restate (04-investor-portal.md 5.9 "Procedures", P35,
// P39; package P13b).
//
// Needs `llc-financials: update` AND `governance: update` (both subjects in
// one `meta`: the RBAC check requires every subject listed). Input
// `{ fromMonth, toMonth, reason }` (months as their first day, reason 10–500
// characters after trimming). The work, the locks, the range rules and the
// audit row `financials.restated` are `restateSnapshots` (P13a), called first
// inside a transaction with release's bounds. Output `{ months, unchanged }`:
// each restated month with its new version, the fund fields that changed and
// the number of holders whose record changed; the months of the range left
// as they were because they already equal the ledger.

import { restateSnapshots } from "@/server/portal/financial-snapshot-write";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZRestateInput } from "../schema";

export const restateProcedure = withLlcAccessControl
  .meta({
    policies: {
      "llc-financials": { allow: ["update"] },
      governance: { allow: ["update"] },
    },
  })
  .input(ZRestateInput)
  .mutation(({ ctx, input }) =>
    ctx.db.$transaction(
      (tx) =>
        restateSnapshots(tx, {
          companyId: ctx.membership.companyId,
          fromMonth: input.fromMonth,
          toMonth: input.toMonth,
          reason: input.reason,
          actor: {
            userId: ctx.session.user.id,
            userName: ctx.session.user.name ?? "A user",
            memberId: ctx.membership.memberId,
            requestIp: ctx.requestIp,
            userAgent: ctx.userAgent,
          },
        }),
      { maxWait: 10_000, timeout: 60_000 },
    ),
  );
