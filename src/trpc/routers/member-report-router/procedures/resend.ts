import { TRPCError } from "@trpc/server";
import {
  emitReportEmails,
  type ReportEmailJobData,
} from "@/jobs/governance-report-email";
import { reportTokenExpiry } from "@/lib/governance/token-payload";
import { Audit } from "@/server/audit";
import { completeK1DeadlinesIfCovered } from "@/server/governance/k1-coverage";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportResendSchema } from "../schema";
import { k1Holders } from "./audience";
import {
  auditContext,
  badRequest,
  findReportRef,
  loadLockedReport,
} from "./shared";

// memberReport.resend (03-governance.md G12): SENT only.
//
// TAX_K1: first adds a recipient row for every holder that now has a K-1
// attached but no row yet (a late K-1; C3.7 allows adding recipients).
// Then queues one email for the given recipient, or for every recipient,
// with `seq = recipient.sendCount` (read under the report lock, after the
// rows were added). This is also the RECOVERY path of the email job: a
// recipient whose first email was never queued (failed emit after send) or
// whose claim was taken by a run that crashed before sending has a
// `sendCount` that no finished send consumed, so the job claims and sends.
// The job is emitted after the transaction commits; a failed emit is an
// error here (nothing was sent, the caller can retry).

export const resendProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportResendSchema)
  .mutation(async ({ ctx, input }) => {
    // Production with the bundled mail catcher: refused before anything
    // is written (Members would not receive the email).
    assertMailDeliverable("MEMBER_EMAIL");
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const userName = ctx.session.user.name ?? "A user";

    const items = await ctx.db.$transaction(
      async (tx) => {
        // TAX_K1 may close the year's K-1 deadlines (it reads holdings):
        // ECONOMICS' ledger and unit-class locks first, as `send`, then the
        // report lock; other types take the report lock only.
        const ref = await findReportRef(tx, companyId, input.publicId);
        if (ref.type === "TAX_K1") {
          await lockCompanyLedgerAndUnitClasses(tx, companyId);
        }
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "SENT") {
          badRequest("Only a sent report can be re-sent.");
        }

        let added: string[] = [];
        if (report.type === "TAX_K1") {
          const existing = await tx.memberReportRecipient.findMany({
            where: { reportId: report.id, companyId },
            select: { stakeholderId: true },
          });
          const have = new Set(existing.map((r) => r.stakeholderId));
          const late = (await k1Holders(tx, companyId, report.id)).filter(
            (h) => !have.has(h.stakeholderId),
          );
          for (const h of late) {
            if (h.email === "") badRequest(`${h.name} has no notice email.`);
          }
          if (late.length > 0) {
            await tx.memberReportRecipient.createMany({
              data: late.map((h) => ({
                reportId: report.id,
                companyId,
                stakeholderId: h.stakeholderId,
                name: h.name,
                email: h.email,
                tokenExpiresAt: reportTokenExpiry(now),
              })),
              skipDuplicates: true,
            });
            added = late.map((h) => h.name);
          }
        }

        // R25: once every holder of the year has its K-1, the year's K-1
        // deadlines are done (they stayed open after a partial send).
        let k1Done: string[] = [];
        if (report.type === "TAX_K1" && report.fiscalYear) {
          ({ done: k1Done } = await completeK1DeadlinesIfCovered(tx, {
            companyId,
            fiscalYear: report.fiscalYear,
            reportId: report.id,
            memberId: ctx.membership.memberId,
            now,
          }));
        }

        const recipients = await tx.memberReportRecipient.findMany({
          where: {
            reportId: report.id,
            companyId,
            ...(input.recipientId ? { id: input.recipientId } : {}),
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: { id: true, name: true, sendCount: true },
        });
        if (input.recipientId && recipients.length === 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Recipient not found.",
          });
        }

        const who =
          input.recipientId && recipients[0]
            ? recipients[0].name
            : `all ${recipients.length} recipients`;
        await Audit.create(
          {
            action: "memberReport.resent",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary: `${userName} re-sent the report "${report.title}" to ${who}${
              added.length > 0
                ? ` (new K-1 recipients: ${added.join(", ")})`
                : ""
            }${k1Done.length > 0 ? `; deadlines done: ${k1Done.join(", ")}` : ""}`,
          },
          tx,
        );

        return recipients.map(
          (r): ReportEmailJobData => ({ recipientId: r.id, seq: r.sendCount }),
        );
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    await emitReportEmails(items);
    return { queued: items.length };
  });
