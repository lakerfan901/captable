import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportListSchema } from "../schema";
import { readFrozenContent, ymdOrNull } from "./shared";

// memberReport.list (03-governance.md G12): the company's reports, newest
// first. After release the title shown is the one frozen at release.
//
// `sentAt` is the RELEASE time (04-investor-portal.md 5.5): a report can be
// released without email. `emailedCount` counts the recipients whose email
// the mail server accepted; `publishedAt` / `unpublishedAt` give the portal
// state (both null: released before the portal existed).

export const listProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberReportListSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const reports = await ctx.db.memberReport.findMany({
      where: { companyId, ...(input.type ? { type: input.type } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        publicId: true,
        type: true,
        title: true,
        status: true,
        fiscalYear: true,
        fiscalQuarter: true,
        noticeKind: true,
        dueOn: true,
        sentAt: true,
        publishedAt: true,
        unpublishedAt: true,
        frozenContent: true,
        _count: { select: { recipients: true } },
      },
    });
    const reportIds = reports.map((r) => r.id);
    const [viewed, emailed] =
      reports.length === 0
        ? [[], []]
        : await Promise.all([
            ctx.db.memberReportRecipient.groupBy({
              by: ["reportId"],
              where: {
                companyId,
                reportId: { in: reportIds },
                firstViewedAt: { not: null },
              },
              _count: { _all: true },
            }),
            ctx.db.memberReportRecipient.groupBy({
              by: ["reportId"],
              where: {
                companyId,
                reportId: { in: reportIds },
                sentAt: { not: null },
              },
              _count: { _all: true },
            }),
          ]);
    const viewedBy = new Map(viewed.map((v) => [v.reportId, v._count._all]));
    const emailedBy = new Map(emailed.map((v) => [v.reportId, v._count._all]));

    return reports.map((r) => ({
      publicId: r.publicId,
      type: r.type,
      title:
        r.status === "SENT"
          ? (readFrozenContent(r.frozenContent)?.title ?? r.title)
          : r.title,
      status: r.status,
      fiscalYear: r.fiscalYear,
      fiscalQuarter: r.fiscalQuarter,
      noticeKind: r.noticeKind,
      dueOn: ymdOrNull(r.dueOn),
      /** Release time (not an email date). */
      sentAt: r.sentAt,
      publishedAt: r.publishedAt,
      unpublishedAt: r.unpublishedAt,
      recipientCount: r._count.recipients,
      emailedCount: emailedBy.get(r.id) ?? 0,
      viewedCount: viewedBy.get(r.id) ?? 0,
    }));
  });
