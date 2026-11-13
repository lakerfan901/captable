import { TRPCError } from "@trpc/server";
import { GOVERNANCE_TIME_ZONE, utcDateToYmd } from "@/lib/governance/dates";
import { withoutAuth } from "@/trpc/api/trpc";
import { readFrozenContent } from "../../member-report-router/procedures/shared";
import { visibleAttachmentWhere } from "../access";
import { ZReportTokenSchema } from "../schema";
import { resolveRecipient } from "./resolve";

// memberReportView.view (03-governance.md G12). Public: the token is the
// credential.
//
// Returns ONLY what this recipient may see: the content frozen at send
// (title, figures for QUARTERLY / ANNUAL, the document), the report's
// period and send date, the recipient's own name, and the attachments that
// are shared or private to THIS recipient's holder (TAX_K1: own files only).
// Never other recipients, emails, internal ids other than the attachment
// ids the same token may open, storage keys or view counts. The output is
// built field by field.
//
// A MUTATION (POST), like every public report procedure: the token is a
// credential and must never travel in a URL (tRPC sends query inputs in the
// query string, which reaches access logs, proxies and Sentry).

export const viewProcedure = withoutAuth
  .input(ZReportTokenSchema)
  .mutation(async ({ ctx, input }) => {
    const resolved = await resolveRecipient(ctx.db, input.token, new Date());
    if (resolved.kind === "REPLACED") {
      return { state: "REPLACED" as const, company: resolved.company };
    }
    const { recipient, report, company } = resolved;

    const frozen = readFrozenContent(report.frozenContent);
    if (frozen === null) {
      // Data integrity problem on a sent report; reveal nothing about it.
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
    const attachments = await ctx.db.memberReportAttachment.findMany({
      where: {
        reportId: report.id,
        companyId: report.companyId,
        ...visibleAttachmentWhere(recipient.stakeholderId, report.type),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, kind: true, stakeholderId: true },
    });

    return {
      state: "OK" as const,
      company: { name: company.name, logo: company.logo },
      timeZone: company.timezone || GOVERNANCE_TIME_ZONE,
      recipient: { name: recipient.name },
      report: {
        title: frozen.title,
        type: report.type,
        noticeKind: report.noticeKind,
        periodStart:
          report.periodStart === null ? null : utcDateToYmd(report.periodStart),
        periodEnd:
          report.periodEnd === null ? null : utcDateToYmd(report.periodEnd),
        sentAt: report.sentAt,
        figures:
          report.type === "QUARTERLY" || report.type === "ANNUAL"
            ? frozen.figures
            : null,
        doc: frozen.doc,
      },
      attachments: attachments.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        private: a.stakeholderId !== null,
      })),
    };
  });
