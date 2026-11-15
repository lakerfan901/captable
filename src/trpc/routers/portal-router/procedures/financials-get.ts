// portal.financials.get (04-investor-portal.md 5.4, 5.9 "Procedures",
// P33–P36; package P13b).
//
// The holder of `input.access` (P10: resolved by `investorProcedure` from the
// access row only, G2) sees, from the stored snapshots only (P34, S26):
// fund records and its own records through its published-through date, which
// is recomputed on every call from the quarterly and annual reports visible to
// it now (P33: unpublishing or removing it from a report moves the date back
// at once); the quarters and years of those months, each with the public id
// of the report of that period it may open; the restatement notes of what it
// sees (P35); the term clock. Without a published period: empty arrays, null
// dates and no term clock. Holder records are read by `ctx.holder` only
// (P36) and carry `holderId: "self"`, never an internal id (G4).
//
// A query: the RSC page loads it, so it writes no access-log row (the plan
// defines no event for viewing the dashboard; exporting it, P17, writes
// FINANCIALS_EXPORTED).

import { holderFinancialView } from "@/server/portal/financial-view";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export const financialsGetProcedure = investorProcedure.query(({ ctx }) =>
  holderFinancialView(ctx.db, ctx.holder, ctx.company),
);
