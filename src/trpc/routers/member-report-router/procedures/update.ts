import { ReportFiguresSchema } from "@/lib/governance/report-figures";
import { normalizeBlocks } from "@/lib/governance/rich-doc";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportUpdateSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadLockedReport,
  usesFigures,
} from "./shared";

// memberReport.update (03-governance.md G12): title, figures and commentary
// of a DRAFT (C3.7: content is mutable only while DRAFT).
//
// Row lock, re-read, require DRAFT, then one single-row guarded update as a
// backstop. Figures must parse with the strict `ReportFiguresSchema`
// (QUARTERLY / ANNUAL; TAX_K1 and NOTICE have none and the input is
// ignored); the commentary must normalize into the rich document model. The
// BlockNote blocks are stored as given (the editor reloads them); `send`
// freezes their normalized form.

export const updateProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportUpdateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const report = await loadLockedReport(tx, companyId, input.publicId);
      const onlyDraft = "Only a draft can be edited.";
      if (report.status !== "DRAFT") badRequest(onlyDraft);

      let figures: object | undefined;
      if (usesFigures(report.type)) {
        const parsed = ReportFiguresSchema.safeParse(input.figures);
        if (!parsed.success) {
          badRequest(
            `The figures are invalid: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          );
        }
        figures = parsed.data as object;
      }
      const normalized = normalizeBlocks(input.commentary);
      if (!normalized.ok) badRequest(normalized.errors.slice(0, 5).join("; "));

      const updated = await guardedWrite(() =>
        tx.memberReport.update({
          where: { id: report.id, companyId, status: "DRAFT" },
          data: {
            title: input.title,
            ...(figures !== undefined ? { figures } : {}),
            commentary: input.commentary as object[],
          },
          select: { id: true },
        }),
      );
      if (!updated) badRequest(onlyDraft);

      await Audit.create(
        {
          action: "memberReport.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "memberReport", id: report.id }],
          summary: `${ctx.session.user.name ?? "A user"} edited the draft report "${input.title}"`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
