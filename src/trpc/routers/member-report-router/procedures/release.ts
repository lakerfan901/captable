import { TRPCError } from "@trpc/server";
import { emitReportEmails } from "@/jobs/governance-report-email";
import { emitReportFile } from "@/jobs/governance-report-file";
import { formatDateOnly } from "@/lib/date-only";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import {
  refusalMessage,
  releaseAuditSummary,
  reportDeadlineKeys,
} from "@/lib/governance/release-core";
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
import {
  type AudienceWarning,
  audienceProblems,
  type DeadlineOutcome,
  deadlineOutcome,
} from "@/lib/portal/audience-core";
import { Audit } from "@/server/audit";
import type { db as Db } from "@/server/db";
import { emitAfterCommit } from "@/server/governance/emit";
import { guardedWrite } from "@/server/governance/guarded";
import { sha256Hex } from "@/server/governance/hash";
import {
  K1_RULE_KEYS,
  k1DedupeKeys,
  loadK1Coverage,
} from "@/server/governance/k1-coverage";
import { closeBooksThrough } from "@/server/llc/economics";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportReleaseSchema } from "../schema";
import { loadAudienceContext } from "./audience";
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

// memberReport.release (04-investor-portal.md P17–P23, 5.5; package P4a).
// Replaces `memberReport.send` (03-governance.md G12), which is now the
// legacy entry point `send.ts`: a release to the default audience with
// email, until the release dialog (P4c) calls `release` directly.
//
// Irreversible, in ONE transaction with `now` taken once, in the order and
// with the locks of the former `send`:
// 0. Locks, in this order: ECONOMICS' company ledger lock FIRST (every
//    economics mutation takes it first, and step 6 closes the books) with
//    the unit-class locks (so no admission commits between the audience's
//    status and unit reads), then the report's row lock; the row is re-read
//    after all of them and must be DRAFT.
// 1. Content: commentary normalizes; the checklist (R23–R26) is complete;
//    a QUARTERLY / ANNUAL period has ended.
// 2. Audience (P18): every holder of the company is loaded under the locks;
//    the confirmed ids are checked with `audienceProblems` against them
//    (unknown or foreign id, duplicate, prospect, other status, a TAX_K1
//    recipient without a K-1 attached, no notice address when emailing, an
//    unlinked transfer notice). Any refusal: nothing is written. The legacy
//    `send` takes the default preset (the rule-based audience of R22, R22a)
//    from the same holders and keeps its former messages.
// 3. One recipient row per confirmed holder (token expiry = now + 400 days,
//    `addedById` = the Manager user's member id). A row means "in the
//    confirmed audience"; whether it was emailed is the row's own `sentAt`.
// 4. Frozen content + hash; DRAFT -> SENT, `sentAt` (now: RELEASED, not
//    emailed) and `publishedAt` by a single-row guarded update.
// 5. Deadlines (P22, `deadlineOutcome`): DONE only when emailing to every
//    current Member (for a transfer notice: every other Preferred Member);
//    TAX_K1 with email follows the K-1 coverage rule exactly as before
//    (the year's K-1 deadlines close when every holder of the year has been
//    emailed its K-1; the email job closes them on delivery). Otherwise the
//    deadlines stay OPEN and the audit says so; the Manager user can
//    complete them on the compliance page.
// 6. QUARTERLY / ANNUAL: `closeBooksThrough(periodEnd)`, with or without
//    email (P17). Not caught: if it throws, the whole release rolls back.
// 7. Audit `memberReport.released`.
// After commit: one `governance.report-email` job per recipient (seq 0)
// only when emailing; the filing job always. A failed emit is logged, never
// an error (the report IS released); `memberReport.resend` re-queues.
//
// Production with the bundled mail catcher: a release WITH email is refused
// before anything is written (P23); a portal-only release sends nothing and
// needs no mail service.

/** Shown by `release` and by the review dialog when the period has not ended. */
export function periodNotEndedMessage(periodEnd: string): string {
  return `This period has not ended yet. A report can be sent, and the books closed, only after ${formatDateOnly(periodEnd)}.`;
}

/** What `release` needs from the tRPC context of `withLlcAccessControl`. */
export interface ReleaseContext {
  db: typeof Db;
  membership: { companyId: string; memberId: string };
  company: { timezone: string | null };
  session: { user: { id: string; name?: string | null } };
  requestIp: string;
  userAgent: string;
}

export type ReleaseAudience =
  | { kind: "SELECTED"; stakeholderIds: readonly string[] }
  /** The legacy `send`: the default preset, derived under the locks. */
  | { kind: "DEFAULT" };

export interface ReleaseResult {
  publicId: string;
  recipientCount: number;
  emailed: boolean;
  /** Report emails handed to the queue (0 when not emailing or when the emit failed). */
  queued: number;
  deadlineOutcome: DeadlineOutcome;
  deadlinesDone: string[];
  /** Open deadlines this release would have closed and left open (P22). */
  deadlinesLeftOpen: string[];
  /** Departures from the default audience (S5); never block. */
  warnings: AudienceWarning[];
}

export async function releaseReport(
  ctx: ReleaseContext,
  input: { publicId: string; audience: ReleaseAudience; email: boolean },
): Promise<ReleaseResult> {
  // P23: with email, production with the bundled mail catcher is refused
  // before anything is written (Members would not receive the email).
  if (input.email) assertMailDeliverable("REPORT");
  const legacy = input.audience.kind === "DEFAULT";
  const companyId = ctx.membership.companyId;
  const memberId = ctx.membership.memberId;
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
        badRequest(
          legacy
            ? "This report has already been sent."
            : "This report has already been released.",
        );
      }
      const type = asReportType(report.type);
      const title = report.title.trim();
      if (title === "") badRequest("The report needs a title.");

      // 1. Content.
      const normalized = normalizeBlocks(report.commentary);
      if (!normalized.ok) badRequest(normalized.errors.slice(0, 5).join("; "));
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
      // Owner ruling (G13): releasing closes the books through the period
      // end, so the period must have ended (strictly before today in the
      // company time zone).
      const today = todayInZone(now, zone);
      if (usesFigures(type) && periodEnd !== null && !(periodEnd < today)) {
        badRequest(periodNotEndedMessage(periodEnd));
      }

      // 2. Audience: every holder under the locks, then the checks.
      const audience = await loadAudienceContext(tx, companyId, report, today);
      const byId = new Map(audience.holders.map((h) => [h.stakeholderId, h]));
      let selectedIds: readonly string[];
      if (input.audience.kind === "DEFAULT") {
        // The former `send` (R22, R22a) with its messages.
        const preset = audience.presets.presets.find(
          (p) => p.key === audience.presets.defaultPreset,
        );
        if (!preset) badRequest("This notice is not linked to a transfer.");
        if (preset.stakeholderIds.length === 0) {
          badRequest(
            type === "TAX_K1"
              ? "No holder would receive this report: attach a Schedule K-1 for a Member or a holder of a Financial Interest."
              : "No Member would receive this report.",
          );
        }
        for (const id of preset.stakeholderIds) {
          const h = byId.get(id);
          if (h && h.noticeEmail === "") {
            badRequest(`${h.name} has no notice email.`);
          }
        }
        selectedIds = preset.stakeholderIds;
      } else {
        selectedIds = input.audience.stakeholderIds;
      }
      const checked = audienceProblems(type, selectedIds, audience.holders, {
        noticeKind: report.noticeKind,
        transferorId: audience.transferorId,
        email: input.email,
      });
      if (checked.refusals.length > 0) {
        badRequest(
          refusalMessage(checked.refusals, (id) => byId.get(id)?.name),
        );
      }
      const selected = new Set(selectedIds);
      // In the order of the register (name, then id), as before.
      const members = audience.holders.filter((h) =>
        selected.has(h.stakeholderId),
      );

      // 3. Recipient rows.
      const tokenExpiresAt = reportTokenExpiry(now);
      await tx.memberReportRecipient.createMany({
        data: members.map((m) => ({
          reportId: report.id,
          companyId,
          stakeholderId: m.stakeholderId,
          name: m.name,
          email: m.noticeEmail,
          tokenExpiresAt,
          addedById: memberId,
        })),
      });
      const recipients = await tx.memberReportRecipient.findMany({
        where: { reportId: report.id, companyId },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });

      // 4. Freeze, hash, DRAFT -> SENT (released) and published.
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
            sentById: memberId,
            publishedAt: now,
            publishedById: memberId,
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

      // 5. Deadlines satisfied by this report (P22).
      const outcome = deadlineOutcome(
        type,
        input.email,
        selectedIds,
        audience.deadlineAudienceIds,
      );
      const dedupeKeys = reportDeadlineKeys(report);
      // TAX_K1 (R25 "to each Member", R22a): the year's K-1 deadlines are
      // done only when EVERY holder of Units during the fiscal year has been
      // emailed its K-1 of that year. A partial delivery leaves them OPEN;
      // the email job closes them once the last K-1 email went out.
      let k1Missing: string[] = [];
      let k1KeysOpen: string[] = [];
      if (type === "TAX_K1" && report.fiscalYear) {
        if (outcome.outcome === "K1_COVERAGE") {
          const coverage = await loadK1Coverage(
            tx,
            companyId,
            report.fiscalYear,
          );
          if (coverage.complete) {
            dedupeKeys.push(...k1DedupeKeys(report.fiscalYear));
          } else {
            k1Missing = coverage.missing;
            k1KeysOpen = k1DedupeKeys(report.fiscalYear);
          }
        } else {
          dedupeKeys.push(...k1DedupeKeys(report.fiscalYear));
        }
      }
      let relatedDeadlineId =
        report.relatedType === "COMPLIANCE_DEADLINE" && report.relatedId
          ? report.relatedId
          : null;
      if (relatedDeadlineId !== null && k1KeysOpen.length > 0) {
        // A K-1 deadline the report was created from follows the same rule.
        const related = await tx.complianceDeadline.findFirst({
          where: { id: relatedDeadlineId, companyId },
          select: { ruleKey: true },
        });
        if (
          related &&
          (K1_RULE_KEYS as readonly string[]).includes(related.ruleKey)
        ) {
          relatedDeadlineId = null;
        }
      }
      const or = [
        ...(dedupeKeys.length > 0 ? [{ dedupeKey: { in: dedupeKeys } }] : []),
        ...(relatedDeadlineId ? [{ id: relatedDeadlineId }] : []),
      ];
      const deadlinesDone: string[] = [];
      const deadlinesLeftOpen: string[] = [];
      if (or.length > 0) {
        const open = await tx.complianceDeadline.findMany({
          where: { companyId, status: "OPEN", OR: or },
          select: { id: true, dedupeKey: true },
          orderBy: { dedupeKey: "asc" },
        });
        for (const deadline of open) {
          if (outcome.outcome === "STAYS_OPEN") {
            deadlinesLeftOpen.push(deadline.dedupeKey);
            continue;
          }
          const done = await guardedWrite(() =>
            tx.complianceDeadline.update({
              where: { id: deadline.id, companyId, status: "OPEN" },
              data: {
                status: "DONE",
                satisfiedByType: "MEMBER_REPORT",
                satisfiedById: report.id,
                completedAt: now,
                completedById: memberId,
              },
              select: { id: true },
            }),
          );
          if (done) deadlinesDone.push(deadline.dedupeKey);
        }
      }

      // 6. Close the books through the period end (QUARTERLY / ANNUAL).
      const booksClosed = usesFigures(type) && periodEnd !== null;
      if (booksClosed) {
        await closeBooksThrough(tx, companyId, periodEnd);
      }

      // 7. Audit.
      await Audit.create(
        {
          action: "memberReport.released",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "memberReport", id: report.id }],
          summary: releaseAuditSummary({
            userName,
            title,
            recipientNames: recipients.map((r) => r.name),
            emailed: input.email,
            booksClosedThrough: booksClosed ? periodEnd : null,
            deadlinesDone,
            k1Missing,
            fiscalYear: report.fiscalYear,
            deadlinesLeftOpen,
          }),
        },
        tx,
      );

      return {
        publicId: report.publicId,
        reportId: report.id,
        recipientIds: recipients.map((r) => r.id),
        outcome: outcome.outcome,
        deadlinesDone,
        deadlinesLeftOpen,
        warnings: checked.warnings,
      };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  // After commit only (H2): the report IS released; a failed emit is logged
  // and `memberReport.resend` re-queues the emails.
  let queued = 0;
  if (input.email) {
    const ok = await emitAfterCommit(
      "member report emails",
      { reportId: result.reportId },
      () =>
        emitReportEmails(
          result.recipientIds.map((recipientId) => ({ recipientId, seq: 0 })),
        ),
    );
    if (ok) queued = result.recipientIds.length;
  }
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
    emailed: input.email,
    queued,
    deadlineOutcome: result.outcome,
    deadlinesDone: result.deadlinesDone,
    deadlinesLeftOpen: result.deadlinesLeftOpen,
    warnings: result.warnings,
  };
}

export const releaseProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportReleaseSchema)
  .mutation(({ ctx, input }) =>
    releaseReport(ctx, {
      publicId: input.publicId,
      audience: { kind: "SELECTED", stakeholderIds: input.stakeholderIds },
      email: input.email,
    }),
  );
