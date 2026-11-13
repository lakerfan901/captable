import type { ResolutionType } from "@/lib/governance/presets";
import { loadEvaluation } from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionListSchema } from "../schema";
import { closeOverdue, draftSpecs, requirementLabel } from "./get";

// resolution.list (03-governance.md G7).

export interface RequirementSummary {
  label: string;
  forBps: number;
  passed: boolean;
}

export const listProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZResolutionListSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();

    const overdue = await ctx.db.resolution.findMany({
      where: { companyId, status: "SENT", closesAt: { lt: now } },
      select: { id: true },
    });
    await closeOverdue(
      ctx.db,
      overdue.map((r) => r.id),
      now,
      "resolution.list",
    );

    const rows = await ctx.db.resolution.findMany({
      where: {
        companyId,
        ...(input.statuses ? { status: { in: input.statuses } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        publicId: true,
        referenceCode: true,
        title: true,
        type: true,
        status: true,
        params: true,
        snapshotId: true,
        sentAt: true,
        closesAt: true,
        effectiveAt: true,
        closedAt: true,
      },
    });

    const out = [];
    for (const row of rows) {
      let requirementSummaries: RequirementSummary[];
      if (row.status === "DRAFT" || row.snapshotId === null) {
        requirementSummaries = draftSpecs(
          row.type as ResolutionType,
          row.params,
        ).map((s) => ({
          label: requirementLabel({
            kind: s.requirement.kind,
            basis:
              s.requirement.kind === "UNIT_VOTE" ? s.requirement.basis : null,
          }),
          forBps: 0,
          passed: false,
        }));
      } else {
        const ev = await loadEvaluation(ctx.db, row.id);
        requirementSummaries = ev.requirements.map((r, i) => {
          const result = ev.evaluation.results[i];
          const passed = result?.state === "PASSED";
          return {
            label: requirementLabel(r),
            forBps: result?.tally ? result.tally.forBps : passed ? 10_000 : 0,
            passed,
          };
        });
      }
      out.push({
        publicId: row.publicId,
        referenceCode: row.referenceCode,
        title: row.title,
        type: row.type,
        status: row.status,
        sentAt: row.sentAt,
        closesAt: row.closesAt,
        effectiveAt: row.effectiveAt,
        closedAt: row.closedAt,
        requirementSummaries,
      });
    }
    return out;
  });
