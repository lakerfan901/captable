import { TRPCError } from "@trpc/server";
import {
  emitReportEmails,
  type ReportEmailJobData,
} from "@/jobs/governance-report-email";
import { reportTokenExpiry } from "@/lib/governance/token-payload";
import { Audit } from "@/server/audit";
import { emitAfterCommit } from "@/server/governance/emit";
import { guardedWrite } from "@/server/governance/guarded";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportReplaceLinkSchema } from "../schema";
import { auditContext, badRequest, loadLockedReport } from "./shared";

// memberReport.replaceLink (03-governance.md G12): issues a new link for one
// recipient of a SENT report. `tokenVersion + 1` (every older link resolves
// to REPLACED, which shows the company name and logo only), revocation
// cleared, a new expiry, optionally a new email address. The new link is
// emailed by the report-email job after commit; the URL itself is never
// returned, logged, or written to an audit row.
//
// Changing the email (as the ballot flow, owner ruling H1): the old and new
// address are written to the audit row, and after commit the PREVIOUS
// address and the holder's notice email on file are told that the link was
// re-issued to a different address (no link in that notice; never sent to
// the new address).

export const replaceLinkProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportReplaceLinkSchema)
  .mutation(async ({ ctx, input }) => {
    // Production with the bundled mail catcher: refused before anything
    // is written (Members would not receive the email).
    assertMailDeliverable("MEMBER_EMAIL");
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const userName = ctx.session.user.name ?? "A user";

    const result = await ctx.db.$transaction(
      async (tx) => {
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "SENT") {
          badRequest("Links can be replaced only for a sent report.");
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
        const newEmail =
          input.email !== undefined &&
          input.email.toLowerCase() !== recipient.email.trim().toLowerCase()
            ? input.email
            : null;
        const tokenVersion = recipient.tokenVersion + 1;

        const replaced = await guardedWrite(() =>
          tx.memberReportRecipient.update({
            where: {
              id: recipient.id,
              companyId,
              tokenVersion: recipient.tokenVersion,
            },
            data: {
              tokenVersion,
              tokenRevokedAt: null,
              tokenExpiresAt: reportTokenExpiry(now),
              ...(newEmail !== null ? { email: newEmail } : {}),
            },
            select: { id: true },
          }),
        );
        if (!replaced) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This link changed at the same moment. Reload the page.",
          });
        }
        // The seq to emit is read AFTER the version bump, in this
        // transaction (the report lock serialises resend / replaceLink).
        const after = await tx.memberReportRecipient.findFirst({
          where: { id: recipient.id, companyId },
          select: { sendCount: true },
        });

        const notify: string[] = [];
        if (newEmail !== null) {
          const holder = await tx.stakeholder.findFirst({
            where: { id: recipient.stakeholderId, companyId },
            select: { email: true, noticeEmail: true },
          });
          const seen = new Set([newEmail.trim().toLowerCase()]);
          for (const raw of [
            recipient.email,
            holder ? (holder.noticeEmail ?? holder.email) : null,
          ]) {
            const address = raw?.trim();
            if (!address) continue;
            const key = address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            notify.push(address);
          }
        }

        const summary =
          newEmail !== null
            ? `${userName} replaced the report link of ${recipient.name} on "${report.title}" and changed the email from ${recipient.email} to ${newEmail}`
            : `${userName} replaced the report link of ${recipient.name} on "${report.title}"`;
        await Audit.create(
          {
            action: "memberReport.resent",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary,
          },
          tx,
        );
        return {
          recipientId: recipient.id,
          tokenVersion,
          seq: after?.sendCount ?? recipient.sendCount,
          notify,
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    // After commit only. The link IS replaced: a failed emit is logged and
    // `memberReport.resend` re-sends the new link.
    const requestedAt = now.toISOString();
    const items: ReportEmailJobData[] = [
      { recipientId: result.recipientId, seq: result.seq },
      ...result.notify.map(
        (address): ReportEmailJobData => ({
          recipientId: result.recipientId,
          seq: result.tokenVersion,
          kind: "ADDRESS_CHANGED",
          address,
          requestedAt,
        }),
      ),
    ];
    await emitAfterCommit(
      "member report link emails",
      { recipientId: result.recipientId },
      () => emitReportEmails(items),
    );

    return { ok: true as const, tokenVersion: result.tokenVersion };
  });
