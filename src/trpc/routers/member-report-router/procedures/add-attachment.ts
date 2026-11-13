import { Audit } from "@/server/audit";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportAddAttachmentSchema } from "../schema";
import { auditContext, badRequest, loadLockedReport } from "./shared";

// memberReport.addAttachment (03-governance.md G12; C3.7).
//
// The bucket and the holder must belong to the company (`assertCompanyOwns`:
// the bucket key is in the company's namespace and not linked elsewhere).
// Kind rules:
// - K1: report type TAX_K1 and a holder (private to that holder), who must
//   be a Member or a Financial-Interest-only holder (R22a).
// - BALANCE_SHEET / INCOME_STATEMENT: report type ANNUAL, shared (no holder).
// - On a TAX_K1 report EVERY file is private to one holder: its recipients
//   include Financial-Interest-only holders, who receive their own K-1 and
//   nothing else (R22, R22a).
// Allowed while DRAFT; once SENT a file may still be ADDED (e.g. a late
// K-1, followed by `resend`), never removed or replaced.
// Takes the report's row lock so an attachment added during `send` is either
// seen by it (TAX_K1 recipients are derived from the K-1 files) or added
// after the report is SENT.

export const addAttachmentProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportAddAttachmentSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const stakeholderId = input.stakeholderId ?? null;

    return await ctx.db.$transaction(async (tx) => {
      const report = await loadLockedReport(tx, companyId, input.publicId);

      if (input.kind === "K1") {
        if (report.type !== "TAX_K1") {
          badRequest("A Schedule K-1 can be attached to a K-1 delivery only.");
        }
        if (stakeholderId === null) {
          badRequest("Choose the holder this Schedule K-1 is for.");
        }
      }
      if (input.kind === "BALANCE_SHEET" || input.kind === "INCOME_STATEMENT") {
        if (report.type !== "ANNUAL") {
          badRequest(
            "Balance sheets and income statements belong to the annual financial statements (Section 8.2).",
          );
        }
        if (stakeholderId !== null) {
          badRequest(
            "The annual financial statements go to every Member; attach them without a holder.",
          );
        }
      }
      if (report.type === "TAX_K1" && stakeholderId === null) {
        badRequest(
          "Every file of a K-1 delivery is private to one holder: Financial-Interest-only holders receive their own Schedule K-1 only (Sections 1.8, 8.2).",
        );
      }

      await assertCompanyOwns(tx, companyId, {
        bucketIds: [input.bucketId],
        stakeholderIds: [stakeholderId],
      });
      let holderName: string | null = null;
      if (stakeholderId !== null) {
        const holder = await tx.stakeholder.findFirst({
          where: { id: stakeholderId, companyId },
          select: { name: true, memberStatus: true },
        });
        if (!holder) badRequest("The holder was not found.");
        if (input.kind === "K1" && holder.memberStatus === "PROSPECT") {
          badRequest(
            `${holder.name} is not a Member or a holder of a Financial Interest, so no Schedule K-1 is delivered to them.`,
          );
        }
        holderName = holder.name;
      }

      const attachment = await tx.memberReportAttachment.create({
        data: {
          reportId: report.id,
          companyId,
          kind: input.kind,
          name: input.name,
          bucketId: input.bucketId,
          stakeholderId,
        },
        select: { id: true },
      });

      await Audit.create(
        {
          action: "memberReport.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [
            { type: "memberReport", id: report.id },
            { type: "bucket", id: input.bucketId },
          ],
          summary: `${ctx.session.user.name ?? "A user"} attached "${input.name}" (${input.kind}${holderName ? `, private to ${holderName}` : ""}) to the ${report.status === "SENT" ? "sent" : "draft"} report "${report.title}"`,
        },
        tx,
      );
      return { id: attachment.id };
    });
  });
