// portal.reports.get (04-investor-portal.md 5.4; package P5a).
//
// One report visible to the holder (P11) with the content frozen at release
// (never the live draft) and the attachments this holder may see (P12:
// shared files plus files private to this holder; on TAX_K1 only its own).
// Unknown, other-company, draft, never-published, unpublished and
// not-a-recipient ids are the same message-less NOT_FOUND. Built field by
// field (G4): no storage key, bucket id, recipient list or view count.
// A query, so the RSC page can load it; it writes no log row (the page's
// client component calls markViewed from the browser).

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { GOVERNANCE_TIME_ZONE, utcDateToYmd } from "@/lib/governance/dates";
import {
  isPortalExportable,
  portalFigures,
} from "@/lib/portal/report-visibility-core";
import {
  findVisibleReport,
  listVisibleAttachments,
  ZPortalReportId,
} from "@/server/portal/visibility-reports";
import { investorProcedure } from "@/trpc/api/portal-procedure";
import { readFrozenContent } from "../../member-report-router/procedures/shared";

export const reportsGetProcedure = investorProcedure
  .input(z.object({ reportId: ZPortalReportId }))
  .query(async ({ ctx, input }) => {
    const report = await findVisibleReport(ctx.db, ctx.holder, input.reportId);
    const frozen = readFrozenContent(report.frozenContent);
    if (frozen === null) {
      // Data integrity problem on a released report: reveal nothing of it.
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
    const attachments = await listVisibleAttachments(
      ctx.db,
      ctx.holder,
      report,
    );
    return {
      company: { name: ctx.company.name, logo: ctx.company.logo },
      timeZone: ctx.company.timezone || GOVERNANCE_TIME_ZONE,
      holderName: ctx.holder.name,
      report: {
        id: report.publicId,
        title: frozen.title,
        type: report.type,
        noticeKind: report.noticeKind,
        periodStart: report.periodStart
          ? utcDateToYmd(report.periodStart)
          : null,
        periodEnd: report.periodEnd ? utcDateToYmd(report.periodEnd) : null,
        releasedAt: report.sentAt,
        figures: portalFigures(report.type, frozen.figures),
        doc: frozen.doc,
      },
      attachments,
      exportable: isPortalExportable(report.type) && frozen.figures !== null,
    };
  });
