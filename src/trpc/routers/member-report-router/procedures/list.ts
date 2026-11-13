import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportListSchema } from "../schema";
import { readFrozenContent, ymdOrNull } from "./shared";

// memberReport.list (03-governance.md G12): the company's reports, newest
// first. After send the title shown is the one frozen at send.

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
        frozenContent: true,
        _count: { select: { recipients: true } },
      },
    });
    const viewed =
      reports.length === 0
        ? []
        : await ctx.db.memberReportRecipient.groupBy({
            by: ["reportId"],
            where: {
              companyId,
              reportId: { in: reports.map((r) => r.id) },
              firstViewedAt: { not: null },
            },
            _count: { _all: true },
          });
    const viewedBy = new Map(viewed.map((v) => [v.reportId, v._count._all]));

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
      sentAt: r.sentAt,
      recipientCount: r._count.recipients,
      viewedCount: viewedBy.get(r.id) ?? 0,
    }));
  });
