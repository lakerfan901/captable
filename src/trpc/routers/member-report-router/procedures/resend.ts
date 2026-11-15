import { TRPCError } from "@trpc/server";
import {
  emitReportEmails,
  type ReportEmailJobData,
} from "@/jobs/governance-report-email";
import {
  RESEND_SKIP_TEXT,
  resendPlan,
  singleResendRefusal,
  UNPUBLISHED_EMAIL_REFUSAL,
} from "@/lib/governance/recipient-core";
import { Audit } from "@/server/audit";
import { completeK1DeadlinesIfCovered } from "@/server/governance/k1-coverage";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportResendSchema } from "../schema";
import {
  auditContext,
  badRequest,
  findReportRef,
  loadLockedReport,
} from "./shared";

// memberReport.resend (03-governance.md G12; 04-investor-portal.md P21,
// P24, 5.5): SENT only. Emails the existing recipients; it NEVER creates a
// recipient (P21: the stored audience is only what a Manager user confirmed
// at release or with `addRecipients`; a holder that gets a K-1 later is
// added there). Before the investor portal it also added every K-1 holder
// without a row, which re-added holders a Manager user had left out of a
// partial K-1 release.
//
// Which recipients:
// - `recipientId`: that one ("Email this recipient"); refused, naming the
//   holder, when its row has no address (a portal-only recipient without a
//   notice address) or its link is revoked;
// - otherwise `scope` "ALL" (default, as before) every recipient, or
//   "NOT_EMAILED" ("Email all not yet emailed") those whose email was never
//   accepted (`sentAt` null). Rows without an address or with a revoked
//   link are skipped and returned with the reason; nothing with a blank
//   address is ever queued, and `queued` counts exactly what was.
// An UNPUBLISHED report is refused (P24: its emailed link shows that the
// report is withdrawn). A report sent before the portal (never published)
// is emailed as before.
//
// One email per queued recipient with `seq = recipient.sendCount` (read
// under the report lock). This is also the RECOVERY path of the email job:
// a recipient whose first email was never queued (failed emit, a
// portal-only release, an addition without email) or whose claim was taken
// by a run that crashed before sending has a `sendCount` that no finished
// send consumed, so the job claims and sends. The job is emitted after the
// transaction commits; a failed emit is an error here (nothing was sent,
// the caller can retry).
//
// TAX_K1 (R25): once every holder of the year has been EMAILED its K-1, the
// year's K-1 deadlines are done; checked here (ledger and unit-class locks
// first, as `release`) and by the email job on each delivery. No other
// deadline is touched (P22).

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
    const scope = input.scope ?? "ALL";

    const result = await ctx.db.$transaction(
      async (tx) => {
        // TAX_K1 may close the year's K-1 deadlines (it reads holdings):
        // ECONOMICS' ledger and unit-class locks first, as `release`, then
        // the report lock; other types take the report lock only.
        const ref = await findReportRef(tx, companyId, input.publicId);
        if (ref.type === "TAX_K1") {
          await lockCompanyLedgerAndUnitClasses(tx, companyId);
        }
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "SENT") {
          badRequest("Only a sent report can be re-sent.");
        }
        if (report.unpublishedAt !== null) {
          badRequest(UNPUBLISHED_EMAIL_REFUSAL);
        }

        const rows = await tx.memberReportRecipient.findMany({
          where: {
            reportId: report.id,
            companyId,
            ...(input.recipientId ? { id: input.recipientId } : {}),
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: {
            id: true,
            name: true,
            email: true,
            sendCount: true,
            sentAt: true,
            tokenRevokedAt: true,
          },
        });
        let plan: ReturnType<typeof resendPlan>;
        if (input.recipientId) {
          const row = rows[0];
          if (!row) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Recipient not found.",
            });
          }
          const refusal = singleResendRefusal(row);
          if (refusal !== null) badRequest(refusal);
          plan = { queue: [row], skipped: [] };
        } else {
          plan = resendPlan(rows, scope);
        }

        // R25: once every holder of the year has been emailed its K-1, the
        // year's K-1 deadlines are done (they stayed open after a partial
        // or portal-only release).
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

        const n = plan.queue.length;
        const who =
          input.recipientId && plan.queue[0]
            ? plan.queue[0].name
            : scope === "NOT_EMAILED"
              ? `the ${n} ${n === 1 ? "recipient" : "recipients"} not yet emailed`
              : `all ${n} recipients`;
        const skippedText =
          plan.skipped.length > 0
            ? `; not emailed: ${plan.skipped
                .map((s) => `${s.row.name} (${RESEND_SKIP_TEXT[s.reason]})`)
                .join(", ")}`
            : "";
        await Audit.create(
          {
            action: "memberReport.resent",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary: `${userName} re-sent the report "${report.title}" to ${who}${skippedText}${
              k1Done.length > 0 ? `; deadlines done: ${k1Done.join(", ")}` : ""
            }`,
          },
          tx,
        );

        return {
          items: plan.queue.map(
            (r): ReportEmailJobData => ({
              recipientId: r.id,
              seq: r.sendCount,
            }),
          ),
          skipped: plan.skipped.map((s) => ({
            recipientId: s.row.id,
            name: s.row.name,
            reason: s.reason,
          })),
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    await emitReportEmails(result.items);
    return { queued: result.items.length, skipped: result.skipped };
  });
