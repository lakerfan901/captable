// financialDashboard.published (04-investor-portal.md 5.9 "Procedures",
// P39; package P13b).
//
// The dashboard from the stored snapshots. Without input: the team's
// Published view (every current fund record through the latest snapshot
// month, every restated month, the released quarterly and annual reports of
// the periods; no holder records). With `asHolder` (a `Stakeholder.id`):
// "Preview as", exactly the answer of `portal.financials.get` for that
// holder, built by the same function (`readHolderFinancialView`); it also needs
// `portal: read` (FORBIDDEN otherwise), and the holder is loaded by
// `{ id, companyId }` (another company's id is NOT_FOUND).

import { TRPCError } from "@trpc/server";
import { RBAC } from "@/lib/rbac";
import type { TPermission } from "@/lib/rbac/schema";
import {
  companyPublishedView,
  readHolderFinancialView,
} from "@/server/portal/financial-view";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZPublishedInput } from "../schema";

/** P39: "Preview as" also needs `portal: read`. */
export function assertMayPreview(permissions: TPermission[]): void {
  const check = new RBAC()
    .addPolicies({ portal: { allow: ["read"] } })
    .enforce(permissions);
  if (check.err || !check.val.valid) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Previewing what a holder sees needs the investor portal permission.",
    });
  }
}

export const publishedProcedure = withLlcAccessControl
  .meta({ policies: { "llc-financials": { allow: ["read"] } } })
  .input(ZPublishedInput)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const asHolder = input?.asHolder;
    if (asHolder === undefined) {
      return companyPublishedView(ctx.db, companyId, ctx.company);
    }
    assertMayPreview(ctx.permissions);
    const holder = await ctx.db.stakeholder.findFirst({
      where: { id: asHolder, companyId },
      select: { id: true, companyId: true },
    });
    if (holder === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Holder not found." });
    }
    return readHolderFinancialView(
      ctx.db,
      { companyId: holder.companyId, stakeholderId: holder.id },
      ctx.company,
    );
  });
