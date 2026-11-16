// portalAdmin.holderView (04-investor-portal.md 5.6, 6.2; package P9b).
//
// "See what this member sees": the reports and documents one holder of the
// caller's company can see in the investor portal right now. Computed with
// the same modules as the portal itself (`listVisibleReports`, P11, P12;
// `listVisibleDocuments` and `portalDocumentListItem`, P13, P14), so the
// lists are exactly what `portal.reports.list` / `portal.documents.list`
// return for an access of this holder: same rows, same order, same fields.
// Nothing here may filter, add or reorder.
//
// Besides the lists, the facts the dialog needs to explain them:
// - how many portal accesses of this holder are ACTIVE (with none, nobody
//   sees these lists in the portal now; they are what an access would show);
// - the holder's published-through date (`publishedThroughFor`, P33), the
//   same rule as the portal's Financials;
// - whether the team dashboard's "Preview as investor" lists this holder
//   (the predicate of `previewHolders` on that page: a current month record
//   of its own), so the dialog links there only when the preview really
//   opens on this holder.
//
// The holder is looked up within the caller's company: an unknown id and a
// holder of another company are the same NOT_FOUND (S3). Output built field
// by field (G4): public ids, names and dates; no storage key or bucket id.
import { publishedThroughFor } from "@/server/portal/financial-snapshots";
import {
  listVisibleDocuments,
  portalDocumentListItem,
} from "@/server/portal/visibility-documents";
import { listVisibleReports } from "@/server/portal/visibility-reports";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZAccessForHolderInput } from "../schema";
import { memberNotFound } from "./shared";

export const holderViewProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["read"] } } })
  .input(ZAccessForHolderInput)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const found = await ctx.db.stakeholder.findFirst({
      where: { id: input.stakeholderId, companyId },
      select: { id: true, name: true },
    });
    if (found === null) memberNotFound();
    const holder = { companyId, stakeholderId: found.id };

    const [reports, documents, activeAccesses, publishedThrough, snapshot] =
      await Promise.all([
        listVisibleReports(ctx.db, holder),
        listVisibleDocuments(ctx.db, holder),
        ctx.db.portalAccess.count({
          where: { companyId, stakeholderId: found.id, status: "ACTIVE" },
        }),
        publishedThroughFor(ctx.db, holder),
        ctx.db.holderFinancialSnapshot.findFirst({
          where: { companyId, stakeholderId: found.id, supersededAt: null },
          select: { id: true },
        }),
      ]);

    return {
      holderName: found.name,
      activeAccesses,
      reports,
      documents: documents.map(portalDocumentListItem),
      publishedThrough,
      previewable: snapshot !== null,
    };
  });
