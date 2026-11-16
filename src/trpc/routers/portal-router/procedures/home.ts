// portal.home (04-investor-portal.md 5.4; package P8b).
//
// What the Overview of one holder needs besides the dashboard figures
// (`portal.financials.get`, P15): the holder and company names, the
// company's time zone, the newest visible report and the three newest
// shared documents. The same rules as the two lists, through the same
// modules (`listVisibleReports`, P11; `listVisibleDocuments`, P13, P14),
// re-evaluated on every call. The holder and company come only from
// `ctx.holder` / `ctx.company` (P10, G2). Built field by field (G4): public
// ids only, no storage key, bucket id or holder id. A query; no log row.

import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { isInlineContentType } from "@/lib/inline-content-type";
import { listVisibleDocuments } from "@/server/portal/visibility-documents";
import { listVisibleReports } from "@/server/portal/visibility-reports";
import { investorProcedure } from "@/trpc/api/portal-procedure";
import type { PortalDocumentListItem } from "./documents-list";

/** The Overview shows this many of the newest documents. */
export const HOME_DOCUMENT_COUNT = 3;

export const homeProcedure = investorProcedure.query(async ({ ctx }) => {
  const [reports, documents] = await Promise.all([
    listVisibleReports(ctx.db, ctx.holder),
    listVisibleDocuments(ctx.db, {
      companyId: ctx.holder.companyId,
      stakeholderId: ctx.holder.stakeholderId,
    }),
  ]);
  return {
    holderName: ctx.holder.name,
    company: { name: ctx.company.name, logo: ctx.company.logo },
    timeZone: ctx.company.timezone || GOVERNANCE_TIME_ZONE,
    // Both lists are already newest first.
    latestReport: reports[0] ?? null,
    documents: documents.slice(0, HOME_DOCUMENT_COUNT).map(
      (v): PortalDocumentListItem => ({
        id: v.document.publicId,
        name: v.document.name,
        sharedAt: v.sharedAt,
        inline: isInlineContentType(v.file.mimeType),
        sizeBytes: v.file.size,
        category: v.document.recordCategory,
      }),
    ),
  };
});
