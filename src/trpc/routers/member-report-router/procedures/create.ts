import { generatePublicId } from "@/common/id";
import {
  annualFinancialsDueOn,
  k1TargetDueOn,
  quarterBounds,
  quarterlyReportDueOn,
  type Ymd,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import {
  defaultReportTitle,
  EMPTY_FIGURES,
  figuresFromPeriodData,
  type ReportFigures,
} from "@/lib/governance/report-figures";
import { Audit } from "@/server/audit";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportCreateSchema } from "../schema";
import { loadPeriodReportInput } from "./period-data";
import { auditContext, badRequest } from "./shared";

// memberReport.create (03-governance.md G12): a DRAFT report.
//
// QUARTERLY needs year + quarter (period = the quarter, due = quarter end +
// 45 days, R23). ANNUAL and TAX_K1 need a year (period = the calendar year;
// due = Dec 31 + 90 days, R24 / March 31 of the next year, R25). NOTICE needs
// a notice kind. QUARTERLY and ANNUAL figures are prefilled from ECONOMICS'
// period data (read before the write transaction; it is read only).

export const createProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["create"] } } })
  .input(ZMemberReportCreateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const { type } = input;

    if (type !== "QUARTERLY" && input.fiscalQuarter !== undefined) {
      badRequest("A quarter applies to a quarterly report only.");
    }
    if (type !== "NOTICE" && input.noticeKind !== undefined) {
      badRequest("A notice kind applies to a notice only.");
    }
    if ((input.relatedType === undefined) !== (input.relatedId === undefined)) {
      badRequest("A related item needs both its type and its id.");
    }

    let period: { start: Ymd; end: Ymd } | null = null;
    let dueOn: Ymd | null = null;
    let fiscalYear: number | null = null;
    let fiscalQuarter: number | null = null;
    let noticeKind: string | null = null;
    switch (type) {
      case "QUARTERLY": {
        if (
          input.fiscalYear === undefined ||
          input.fiscalQuarter === undefined
        ) {
          badRequest("A quarterly report needs a fiscal year and a quarter.");
        }
        const q = input.fiscalQuarter as 1 | 2 | 3 | 4;
        const bounds = quarterBounds(input.fiscalYear, q);
        period = { start: bounds.start, end: bounds.end };
        dueOn = quarterlyReportDueOn(input.fiscalYear, q);
        fiscalYear = input.fiscalYear;
        fiscalQuarter = q;
        break;
      }
      case "ANNUAL":
      case "TAX_K1": {
        if (input.fiscalYear === undefined) {
          badRequest(
            type === "ANNUAL"
              ? "Annual financial statements need a fiscal year."
              : "A Schedule K-1 delivery needs a tax year.",
          );
        }
        period = {
          start: `${input.fiscalYear}-01-01`,
          end: `${input.fiscalYear}-12-31`,
        };
        dueOn =
          type === "ANNUAL"
            ? annualFinancialsDueOn(input.fiscalYear)
            : k1TargetDueOn(input.fiscalYear);
        fiscalYear = input.fiscalYear;
        break;
      }
      case "NOTICE": {
        if (input.noticeKind === undefined) {
          badRequest("Choose the kind of notice.");
        }
        noticeKind = input.noticeKind;
        fiscalYear = input.fiscalYear ?? null;
        break;
      }
    }

    // Prefill (outside the write transaction: read only, and an ECONOMICS
    // rule violation must surface as its own message).
    let figures: ReportFigures = EMPTY_FIGURES;
    if ((type === "QUARTERLY" || type === "ANNUAL") && period !== null) {
      figures = figuresFromPeriodData(
        await loadPeriodReportInput(ctx.db, companyId, period),
        period,
        now.toISOString(),
      );
    }

    const title =
      input.title ??
      defaultReportTitle({
        type,
        fiscalYear: fiscalYear ?? undefined,
        fiscalQuarter: fiscalQuarter ?? undefined,
        noticeKind: noticeKind ?? undefined,
      });

    return await ctx.db.$transaction(async (tx) => {
      if (input.relatedId !== undefined) {
        const deadline = await tx.complianceDeadline.findFirst({
          where: { id: input.relatedId, companyId },
          select: { id: true },
        });
        if (!deadline) badRequest("The related deadline was not found.");
      }
      const report = await tx.memberReport.create({
        data: {
          publicId: generatePublicId(),
          companyId,
          type,
          status: "DRAFT",
          title,
          fiscalYear,
          fiscalQuarter,
          periodStart: period ? ymdToUtcDate(period.start) : null,
          periodEnd: period ? ymdToUtcDate(period.end) : null,
          noticeKind,
          relatedType: input.relatedType ?? null,
          relatedId: input.relatedId ?? null,
          figures: figures as object,
          commentary: [],
          dueOn: dueOn ? ymdToUtcDate(dueOn) : null,
          authorId: ctx.membership.memberId,
        },
        select: { id: true, publicId: true },
      });
      await Audit.create(
        {
          action: "memberReport.created",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "memberReport", id: report.id }],
          summary: `${ctx.session.user.name ?? "A user"} created the draft report "${title}"`,
        },
        tx,
      );
      return { publicId: report.publicId };
    });
  });
