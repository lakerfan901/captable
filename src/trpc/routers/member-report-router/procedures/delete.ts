import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportDeleteSchema } from "../schema";
import { auditContext, badRequest, loadLockedReport } from "./shared";

// memberReport.delete (03-governance.md G12): DRAFT only, hard delete.
//
// Row lock first (as `send`), re-read, require DRAFT. A draft can have
// attachment rows (never recipients): they are deleted explicitly under the
// lock, then the report by ONE single-row guarded delete. Never a guarded
// `deleteMany` on the report: with emulated cascades Prisma deletes children
// by stale ids before the guarded parent DELETE (server/governance/guarded.ts).
// Uploaded files (buckets) are kept.

export const deleteProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["delete"] } } })
  .input(ZMemberReportDeleteSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const report = await loadLockedReport(tx, companyId, input.publicId);
      const onlyDraft = "Only a draft can be deleted.";
      if (report.status !== "DRAFT") badRequest(onlyDraft);

      // Under the lock, after DRAFT was re-checked: no send can interleave.
      await tx.memberReportAttachment.deleteMany({
        where: { reportId: report.id, companyId },
      });
      const deleted = await guardedWrite(() =>
        tx.memberReport.delete({
          where: { id: report.id, companyId, status: "DRAFT" },
          select: { id: true },
        }),
      );
      if (!deleted) badRequest(onlyDraft);

      await Audit.create(
        {
          action: "memberReport.deleted",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "memberReport", id: report.id }],
          summary: `${ctx.session.user.name ?? "A user"} deleted the draft report "${report.title}"`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
