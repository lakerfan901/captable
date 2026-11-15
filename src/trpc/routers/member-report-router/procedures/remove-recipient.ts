import { TRPCError } from "@trpc/server";
import { removalRefusal } from "@/lib/governance/recipient-core";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportRemoveRecipientSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadLockedReport,
  readFrozenContent,
} from "./shared";

// memberReport.removeRecipient (04-investor-portal.md P19, P16, S5, 5.5;
// package P4b): takes one holder out of the audience of a released report,
// allowed only while the recipient has left no history: never emailed (no
// claim ever taken, no email accepted), never opened through the emailed
// link, and nothing of this report opened in the portal for this holder
// (`removalRefusal`, the same rule as `get`'s `canRemove`).
//
// Under the report lock (re-read after it; SENT only). The report-email job
// claims WITHOUT the report lock, so the rule is also the guard of the
// DELETE itself: one single-row `delete` whose WHERE carries `sendCount 0`,
// `sentAt` null, `firstViewedAt` null, `viewCount 0` and the link version
// read. Postgres re-evaluates that WHERE after waiting for a concurrent
// claim, so either the claim wins (the delete matches nothing: refused,
// "emailed meanwhile") or the delete wins (the job's claim then matches no
// row and sends nothing). A token-page view (`markViewed`) is an update of
// the same row and is ordered the same way.
//
// Portal views are rows of `PortalAccessLog` (written by P5a without a lock
// on the recipient): they are checked before AND after the delete; a view
// committed by then refuses and rolls back. RESIDUAL: a portal request that
// passed its visibility check before the delete committed can still write
// its log row just after; the log row is kept (it is never deleted here)
// and the report is no longer visible to that holder from the next request.
//
// What is deleted is only the recipient row: email-log and portal-log rows
// are never touched (there are none by the rule). The audit row
// `memberReport.recipient-removed` keeps the holder's name, the address,
// whether it had been confirmed by a Manager user (`addedById`) and when.

async function portalTouched(
  tx: PrismaTransactionalClient,
  companyId: string,
  reportId: string,
  stakeholderId: string,
): Promise<boolean> {
  const attachments = await tx.memberReportAttachment.findMany({
    where: { reportId, companyId },
    select: { id: true },
  });
  const row = await tx.portalAccessLog.findFirst({
    where: {
      companyId,
      stakeholderId,
      OR: [
        { targetType: "memberReport", targetId: reportId },
        ...(attachments.length > 0
          ? [
              {
                targetType: "memberReportAttachment",
                targetId: { in: attachments.map((a) => a.id) },
              },
            ]
          : []),
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

export const removeRecipientProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportRemoveRecipientSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const userName = ctx.session.user.name ?? "A user";

    return await ctx.db.$transaction(
      async (tx) => {
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "SENT") {
          badRequest("Recipients can be removed only from a released report.");
        }
        const recipient = await tx.memberReportRecipient.findFirst({
          where: { id: input.recipientId, reportId: report.id, companyId },
        });
        if (!recipient) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Recipient not found.",
          });
        }
        const refusal = removalRefusal({
          ...recipient,
          portalTouched: await portalTouched(
            tx,
            companyId,
            report.id,
            recipient.stakeholderId,
          ),
        });
        if (refusal !== null) badRequest(refusal);

        const deleted = await guardedWrite(() =>
          tx.memberReportRecipient.delete({
            where: {
              id: recipient.id,
              companyId,
              reportId: report.id,
              sendCount: 0,
              sentAt: null,
              firstViewedAt: null,
              viewCount: 0,
              tokenVersion: recipient.tokenVersion,
            },
            select: { id: true },
          }),
        );
        if (!deleted) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This recipient was emailed or opened the report meanwhile and cannot be removed. Reload the page.",
          });
        }
        // A portal view committed between the first check and the delete.
        if (
          await portalTouched(tx, companyId, report.id, recipient.stakeholderId)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This recipient opened the report in the investor portal meanwhile and cannot be removed. Reload the page.",
          });
        }

        const title =
          readFrozenContent(report.frozenContent)?.title ?? report.title;
        const address = recipient.email.trim();
        await Audit.create(
          {
            action: "memberReport.recipient-removed",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [
              { type: "memberReport", id: report.id },
              { type: "stakeholder", id: recipient.stakeholderId },
            ],
            summary: `${userName} removed ${recipient.name}${
              address !== "" ? ` (${address})` : " (no email address)"
            } from the recipients of the report "${title}"; never emailed and never opened; ${
              recipient.addedById !== null
                ? `added ${recipient.createdAt.toISOString()} by a Manager user`
                : "added before the investor portal"
            }`,
          },
          tx,
        );
        return {
          publicId: report.publicId,
          recipientId: recipient.id,
          stakeholderId: recipient.stakeholderId,
          name: recipient.name,
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  });
