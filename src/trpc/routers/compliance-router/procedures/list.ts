import {
  addDays,
  daysBetween,
  utcDateToYmd,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
import { frozenTitle } from "@/server/governance/frozen";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZComplianceListSchema } from "../schema";
import { COMPLIANCE_TX } from "./shared";

// compliance.list (03-governance.md G14): syncs the generated deadlines, then
// returns every OPEN deadline, plus (with `includeClosed`) the DONE and
// NOT_APPLICABLE ones due within the last 400 days or later, ordered by due
// date. Each row adds `daysLeft` (negative when overdue, in the company's
// time zone) and what satisfied it.

const CLOSED_LOOKBACK_DAYS = 400;

export interface SatisfiedBy {
  type: "RESOLUTION" | "MEMBER_REPORT" | "DOCUMENT";
  label: string;
  href: string | null;
}

export const listProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZComplianceListSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const companyPublicId = ctx.company.publicId;

    return await ctx.db.$transaction(async (tx) => {
      const { today } = await syncComplianceDeadlines(
        tx,
        companyId,
        new Date(),
      );

      const rows = await tx.complianceDeadline.findMany({
        where: {
          companyId,
          OR: [
            { status: "OPEN" },
            ...(input.includeClosed
              ? [
                  {
                    status: {
                      in: ["DONE" as const, "NOT_APPLICABLE" as const],
                    },
                    dueOn: {
                      gte: ymdToUtcDate(addDays(today, -CLOSED_LOOKBACK_DAYS)),
                    },
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          ruleKey: true,
          dedupeKey: true,
          title: true,
          section: true,
          description: true,
          dueOn: true,
          status: true,
          source: true,
          sourceType: true,
          sourceId: true,
          completedAt: true,
          completedById: true,
          satisfiedByType: true,
          satisfiedById: true,
          note: true,
          remindedBuckets: true,
          lastReminderAt: true,
        },
      });

      const idsOf = (type: string) => [
        ...new Set(
          rows
            .filter((r) => r.satisfiedByType === type && r.satisfiedById)
            .map((r) => r.satisfiedById as string),
        ),
      ];
      const resolutionIds = idsOf("RESOLUTION");
      const reportIds = idsOf("MEMBER_REPORT");
      const documentIds = idsOf("DOCUMENT");

      const [resolutions, reports, documents] = await Promise.all([
        resolutionIds.length === 0
          ? []
          : tx.resolution.findMany({
              where: { id: { in: resolutionIds }, companyId },
              select: {
                id: true,
                publicId: true,
                referenceCode: true,
                title: true,
                frozenContent: true,
              },
            }),
        reportIds.length === 0
          ? []
          : tx.memberReport.findMany({
              where: { id: { in: reportIds }, companyId },
              select: {
                id: true,
                publicId: true,
                title: true,
                frozenContent: true,
              },
            }),
        documentIds.length === 0
          ? []
          : tx.document.findMany({
              where: { id: { in: documentIds }, companyId },
              select: { id: true, name: true },
            }),
      ]);

      const linked = new Map<string, SatisfiedBy>();
      for (const r of resolutions) {
        const title = frozenTitle(r);
        linked.set(`RESOLUTION:${r.id}`, {
          type: "RESOLUTION",
          label: r.referenceCode ? `${r.referenceCode} ${title}` : title,
          href: `/${companyPublicId}/resolutions/${r.publicId}`,
        });
      }
      for (const r of reports) {
        linked.set(`MEMBER_REPORT:${r.id}`, {
          type: "MEMBER_REPORT",
          label: frozenTitle(r),
          href: `/${companyPublicId}/reports/${r.publicId}`,
        });
      }
      for (const d of documents) {
        linked.set(`DOCUMENT:${d.id}`, {
          type: "DOCUMENT",
          label: d.name,
          href: null,
        });
      }

      return rows.map((r) => {
        const dueOn = utcDateToYmd(r.dueOn);
        const type = r.satisfiedByType;
        let satisfiedBy: SatisfiedBy | null = null;
        if (
          (type === "RESOLUTION" ||
            type === "MEMBER_REPORT" ||
            type === "DOCUMENT") &&
          r.satisfiedById
        ) {
          satisfiedBy = linked.get(`${type}:${r.satisfiedById}`) ?? {
            type,
            label: "No longer available",
            href: null,
          };
        }
        return {
          id: r.id,
          ruleKey: r.ruleKey,
          dedupeKey: r.dedupeKey,
          title: r.title,
          section: r.section,
          description: r.description,
          dueOn,
          daysLeft: daysBetween(today, dueOn),
          status: r.status,
          source: r.source,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          completedAt: r.completedAt,
          completedById: r.completedById,
          satisfiedByType: r.satisfiedByType,
          satisfiedBy,
          note: r.note,
          remindedBuckets: r.remindedBuckets,
          lastReminderAt: r.lastReminderAt,
          canEditTitle: r.status === "OPEN" && r.ruleKey === "CUSTOM",
          canEditDueOn:
            r.status === "OPEN" &&
            (r.ruleKey === "CUSTOM" || r.ruleKey === "K1_FINAL"),
        };
      });
    }, COMPLIANCE_TX);
  });
