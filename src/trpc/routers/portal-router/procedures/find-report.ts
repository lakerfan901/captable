// portal.findReport (04-investor-portal.md 5.4, 6.1; package P5a).
//
// For the landing page after an emailed link (`/portal/go/report/[reportId]`,
// P5b): which of the signed-in user's holders may see that report (P11).
// Each candidate access passes the same checks as `investorProcedure` and
// `portal.me` (own user, ACTIVE, holder row in the access's company, LLC
// company), then the report rule per holder. An unknown or invisible report
// is `{ matches: [] }`, the same as one visible to none of the user's
// holders. Returns only the access public id and the holder's name.

import { z } from "zod";
import {
  isReportVisible,
  ZPortalReportId,
} from "@/server/portal/visibility-reports";
import { portalSessionProcedure } from "@/trpc/api/portal-procedure";

export const findReportProcedure = portalSessionProcedure
  .input(z.object({ reportId: ZPortalReportId }))
  .query(async ({ ctx, input }) => {
    const accesses = await ctx.db.portalAccess.findMany({
      where: { portalUserId: ctx.portalUser.id, status: "ACTIVE" },
      select: { publicId: true, companyId: true, stakeholderId: true },
    });
    if (accesses.length === 0) return { matches: [] };
    const companyIds = [...new Set(accesses.map((a) => a.companyId))];
    const [stakeholders, companies] = await Promise.all([
      ctx.db.stakeholder.findMany({
        where: {
          id: { in: accesses.map((a) => a.stakeholderId) },
          companyId: { in: companyIds },
        },
        select: { id: true, companyId: true, name: true },
      }),
      ctx.db.company.findMany({
        where: { id: { in: companyIds }, entityType: "LLC" },
        select: { id: true },
      }),
    ]);
    const stakeholderById = new Map(stakeholders.map((s) => [s.id, s]));
    const llc = new Set(companies.map((c) => c.id));

    const matches: { access: string; holderName: string }[] = [];
    for (const access of accesses) {
      const holder = stakeholderById.get(access.stakeholderId);
      if (!holder || holder.companyId !== access.companyId) continue;
      if (!llc.has(access.companyId)) continue;
      const visible = await isReportVisible(
        ctx.db,
        { companyId: access.companyId, stakeholderId: holder.id },
        input.reportId,
      );
      if (visible) {
        matches.push({ access: access.publicId, holderName: holder.name });
      }
    }
    matches.sort(
      (a, b) =>
        a.holderName.localeCompare(b.holderName) ||
        a.access.localeCompare(b.access),
    );
    return { matches };
  });
