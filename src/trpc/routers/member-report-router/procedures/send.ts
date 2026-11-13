import { TRPCError } from "@trpc/server";
import { emitReportEmails } from "@/jobs/governance-report-email";
import { emitReportFile } from "@/jobs/governance-report-file";
import { formatDateOnly } from "@/lib/date-only";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import {
  EMPTY_FIGURES,
  ReportFiguresSchema,
  reportChecklist,
} from "@/lib/governance/report-figures";
import {
  canonicalJson,
  isDocEmpty,
  normalizeBlocks,
} from "@/lib/governance/rich-doc";
import { reportTokenExpiry } from "@/lib/governance/token-payload";
import { Audit } from "@/server/audit";
import { emitAfterCommit } from "@/server/governance/emit";
import { guardedWrite } from "@/server/governance/guarded";
import { sha256Hex } from "@/server/governance/hash";
import { closeBooksThrough } from "@/server/llc/economics";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportSendSchema } from "../schema";
import { deriveAudience } from "./audience";
import {
  asReportType,
  auditContext,
  badRequest,
  findReportRef,
  lockReport,
  reportNotFound,
  usesFigures,
  ymdOrNull,
} from "./shared";

// memberReport.send (03-governance.md G12, "memberReport.send").
//
// Irreversible, in ONE transaction with `now` taken once:
// 0. Locks, in this order: ECONOMICS' company ledger lock FIRST (every
//    economics mutation takes it first, and step 6 closes the books) with
//    the unit-class locks (so no admission commits between the audience's
//    status and unit reads), then the report's row lock; the row is re-read
//    after all of them and must be DRAFT.
// 1. Content: commentary normalizes; the checklist (R23–R26) is complete.
// 2. Recipients, derived on the server (R22, R22a; never from the client).
// 3. One recipient row each (token expiry = now + 400 days).
// 4. Frozen content + hash; DRAFT -> SENT by a single-row guarded update.
// 5. Open compliance deadlines satisfied by this report -> DONE, one guarded
//    single-row update each (rows are created by G14; none may exist yet).
// 6. QUARTERLY / ANNUAL: `closeBooksThrough(periodEnd)`. Not caught: if it
//    throws, the whole send rolls back (fail closed).
// 7. Audit.
// After commit: one `governance.report-email` job per recipient (seq 0). A
// failed emit is logged, never an error (the report IS sent);
// `memberReport.resend` re-queues it.

/** Shown by `send` and by the review dialog when the period has not ended. */
export function periodNotEndedMessage(periodEnd: string): string {
  return `This period has not ended yet. A report can be sent, and the books closed, only after ${formatDateOnly(periodEnd)}.`;
}

export const sendProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportSendSchema)
  .mutation(async ({ ctx, input }) => {
    // Production with the bundled mail catcher: refused before anything
    // is written (Members would not receive the email).
    assertMailDeliverable("REPORT");
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
    const userName = ctx.session.user.name ?? "A user";

    const result = await ctx.db.$transaction(
      async (tx) => {
        // 0. Ledger lock first (with the unit-class locks: the audience reads
        //    member status and units in two statements, and an admission
        //    holds only the unit-class lock), then the report lock, then
        //    re-read.
        const ref = await findReportRef(tx, companyId, input.publicId);
        await lockCompanyLedgerAndUnitClasses(tx, companyId);
        await lockReport(tx, ref.id);
        const report = await tx.memberReport.findFirst({
          where: { id: ref.id, companyId },
        });
        if (!report) reportNotFound();
        if (report.status !== "DRAFT") {
          badRequest("This report has already been sent.");
        }
        const type = asReportType(report.type);
        const title = report.title.trim();
        if (title === "") badRequest("The report needs a title.");

        // 1. Content.
        const normalized = normalizeBlocks(report.commentary);
        if (!normalized.ok)
          badRequest(normalized.errors.slice(0, 5).join("; "));
        const doc = normalized.doc;
        let figures = EMPTY_FIGURES;
        if (usesFigures(type)) {
          const parsed = ReportFiguresSchema.safeParse(report.figures);
          if (!parsed.success) {
            badRequest(
              "The report figures are incomplete. Refresh them from the ledger or fill them in.",
            );
          }
          figures = parsed.data;
        }
        const attachments = await tx.memberReportAttachment.findMany({
          where: { reportId: report.id, companyId },
          select: { kind: true, stakeholderId: true },
        });
        const missing = reportChecklist(
          type,
          figures,
          attachments,
          isDocEmpty(doc),
        ).filter((i) => !i.ok);
        if (missing.length > 0) {
          badRequest(`Incomplete: ${missing.map((i) => i.label).join(", ")}`);
        }
        const periodStart = ymdOrNull(report.periodStart);
        const periodEnd = ymdOrNull(report.periodEnd);
        if (usesFigures(type) && (periodStart === null || periodEnd === null)) {
          badRequest("This report has no period.");
        }
        // Owner ruling (G13): sending closes the books through the period
        // end, so the period must have ended (strictly before today in the
        // company time zone).
        if (
          usesFigures(type) &&
          periodEnd !== null &&
          !(periodEnd < todayInZone(now, zone))
        ) {
          badRequest(periodNotEndedMessage(periodEnd));
        }

        // 2. Recipients.
        const audience = await deriveAudience(
          tx,
          companyId,
          report,
          todayInZone(now, zone),
        );
        if (!audience.ok) badRequest(audience.problem);
        const members = audience.members;
        if (members.length === 0) {
          badRequest(
            type === "TAX_K1"
              ? "No holder would receive this report: attach a Schedule K-1 for a Member or a holder of a Financial Interest."
              : "No Member would receive this report.",
          );
        }
        for (const m of members) {
          if (m.email === "") badRequest(`${m.name} has no notice email.`);
        }

        // 3. Recipient rows.
        const tokenExpiresAt = reportTokenExpiry(now);
        await tx.memberReportRecipient.createMany({
          data: members.map((m) => ({
            reportId: report.id,
            companyId,
            stakeholderId: m.stakeholderId,
            name: m.name,
            email: m.email,
            tokenExpiresAt,
          })),
        });
        const recipients = await tx.memberReportRecipient.findMany({
          where: { reportId: report.id, companyId },
          select: { id: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });

        // 4. Freeze, hash, DRAFT -> SENT.
        const frozen = {
          title,
          type,
          noticeKind: report.noticeKind,
          period:
            periodStart !== null && periodEnd !== null
              ? { start: periodStart, end: periodEnd }
              : null,
          ...(usesFigures(type) ? { figures } : {}),
          doc,
        };
        const canonical = canonicalJson(frozen);
        const frozenHash = sha256Hex(canonical);
        const frozenContent = JSON.parse(canonical) as object;
        const moved = await guardedWrite(() =>
          tx.memberReport.update({
            where: { id: report.id, companyId, status: "DRAFT" },
            data: {
              status: "SENT",
              sentAt: now,
              sentById: ctx.membership.memberId,
              frozenContent,
              frozenHash,
            },
            select: { id: true },
          }),
        );
        if (!moved) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This report has already been sent.",
          });
        }

        // 5. Deadlines satisfied by this report (find, then guard each).
        const dedupeKeys: string[] = [];
        if (type === "QUARTERLY" && report.fiscalYear && report.fiscalQuarter) {
          dedupeKeys.push(
            `QUARTERLY_REPORT:${report.fiscalYear}Q${report.fiscalQuarter}`,
          );
        }
        if (type === "ANNUAL" && report.fiscalYear) {
          dedupeKeys.push(`ANNUAL_FINANCIALS:${report.fiscalYear}`);
        }
        if (type === "TAX_K1" && report.fiscalYear) {
          dedupeKeys.push(
            `K1_TARGET:${report.fiscalYear}`,
            `K1_FINAL:${report.fiscalYear}`,
          );
        }
        const relatedDeadlineId =
          report.relatedType === "COMPLIANCE_DEADLINE" && report.relatedId
            ? report.relatedId
            : null;
        const or = [
          ...(dedupeKeys.length > 0 ? [{ dedupeKey: { in: dedupeKeys } }] : []),
          ...(relatedDeadlineId ? [{ id: relatedDeadlineId }] : []),
        ];
        const deadlinesDone: string[] = [];
        if (or.length > 0) {
          const open = await tx.complianceDeadline.findMany({
            where: { companyId, status: "OPEN", OR: or },
            select: { id: true, dedupeKey: true },
          });
          for (const deadline of open) {
            const done = await guardedWrite(() =>
              tx.complianceDeadline.update({
                where: { id: deadline.id, companyId, status: "OPEN" },
                data: {
                  status: "DONE",
                  satisfiedByType: "MEMBER_REPORT",
                  satisfiedById: report.id,
                  completedAt: now,
                  completedById: ctx.membership.memberId,
                },
                select: { id: true },
              }),
            );
            if (done) deadlinesDone.push(deadline.dedupeKey);
          }
        }

        // 6. Close the books through the period end (QUARTERLY / ANNUAL).
        if (usesFigures(type) && periodEnd !== null) {
          await closeBooksThrough(tx, companyId, periodEnd);
        }

        // 7. Audit.
        const n = recipients.length;
        await Audit.create(
          {
            action: "memberReport.sent",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary: `${userName} sent the report "${title}" to ${n} ${n === 1 ? "recipient" : "recipients"}${
              usesFigures(type) && periodEnd !== null
                ? `; books closed through ${periodEnd}`
                : ""
            }${deadlinesDone.length > 0 ? `; deadlines done: ${deadlinesDone.join(", ")}` : ""}`,
          },
          tx,
        );

        return {
          publicId: report.publicId,
          reportId: report.id,
          recipientIds: recipients.map((r) => r.id),
        };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );

    // After commit only (H2): the report IS sent; a failed emit is logged and
    // `memberReport.resend` re-queues the emails.
    await emitAfterCommit(
      "member report emails",
      { reportId: result.reportId },
      () =>
        emitReportEmails(
          result.recipientIds.map((recipientId) => ({ recipientId, seq: 0 })),
        ),
    );
    // G13: file the PDF in Documents. A lost emit is recovered by the
    // resolution sweep (SENT reports without a filed document).
    await emitAfterCommit(
      "member report filing",
      { reportId: result.reportId },
      () => emitReportFile(result.reportId),
    );

    return {
      publicId: result.publicId,
      recipientCount: result.recipientIds.length,
    };
  });
