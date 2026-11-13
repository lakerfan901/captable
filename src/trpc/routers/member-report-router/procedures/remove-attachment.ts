import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportRemoveAttachmentSchema } from "../schema";
import { auditContext, badRequest, loadLockedReport } from "./shared";

// memberReport.removeAttachment (03-governance.md G12): DRAFT only (C3.7:
// once SENT, attachments are never removed). Under the report's row lock,
// after DRAFT is re-checked; then one single-row delete of an attachment of
// THIS report and company. The file itself (bucket) is kept.

export const removeAttachmentProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportRemoveAttachmentSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const report = await loadLockedReport(tx, companyId, input.publicId);
      if (report.status !== "DRAFT") {
        badRequest("Files of a sent report cannot be removed.");
      }
      const attachment = await tx.memberReportAttachment.findFirst({
        where: { id: input.attachmentId, reportId: report.id, companyId },
        select: { id: true, name: true },
      });
      if (!attachment) badRequest("The file was not found on this report.");

      const deleted = await guardedWrite(() =>
        tx.memberReportAttachment.delete({
          where: { id: attachment.id, reportId: report.id, companyId },
          select: { id: true },
        }),
      );
      if (!deleted) badRequest("The file was not found on this report.");

      await Audit.create(
        {
          action: "memberReport.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "memberReport", id: report.id }],
          summary: `${ctx.session.user.name ?? "A user"} removed "${attachment.name}" from the draft report "${report.title}"`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
