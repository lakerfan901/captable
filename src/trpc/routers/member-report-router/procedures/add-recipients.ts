import { emitReportEmails } from "@/jobs/governance-report-email";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import {
  planAddRecipients,
  UNPUBLISHED_EMAIL_REFUSAL,
} from "@/lib/governance/recipient-core";
import { refusalMessage } from "@/lib/governance/release-core";
import { reportTokenExpiry } from "@/lib/governance/token-payload";
import type { AudienceWarning } from "@/lib/portal/audience-core";
import { Audit } from "@/server/audit";
import { emitAfterCommit } from "@/server/governance/emit";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportAddRecipientsSchema } from "../schema";
import { loadAudienceContext } from "./audience";
import {
  assertMayInvite,
  type InvitationLine,
  type InvitationRun,
  invitationSummary,
  inviteSelectedHolders,
  queueInvitations,
} from "./invitations";
import {
  asReportType,
  auditContext,
  badRequest,
  findReportRef,
  lockReport,
  readFrozenContent,
  reportNotFound,
} from "./shared";

// memberReport.addRecipients (04-investor-portal.md P19, P21, 5.5; package
// P4b): holders added to the audience of a RELEASED report. The stored
// audience stays what a Manager user confirmed: this procedure (and
// `release`) are the only writers of recipient rows; `resend` adds none.
// A holder that gets a K-1 after release is added here (the dialog lists it
// pre-ticked under "K-1 attached, not yet a recipient").
//
// In ONE transaction, with the locks of `release` in its order: ECONOMICS'
// company ledger lock, the unit-class locks (the checks read status and
// units), then the report's row lock; the report is re-read after them.
// - SENT only. With `email` on an UNPUBLISHED report: refused (P24; the
//   emailed link would show a withdrawn report). Without email an
//   unpublished report can gain recipients: they see it when it is
//   published again.
// - The checks of release on the holders being added (`planAddRecipients`
//   over `audienceProblems`): foreign or unknown id, prospect, other status,
//   on a TAX_K1 report no K-1 attached, with email no notice address, a
//   list naming a holder twice. Any refusal: nothing is written.
// - Holders that already have a row are left as they are (not re-emailed:
//   that is `resend`), so a double click or two team members add once.
// - One row per new holder (`addedById` = the Manager user), a fresh link.
// - `inviteMissing`: as `release` (P27), for the added holders.
//
// DEADLINES (P22). Adding recipients closes no deadline, with or without
// email. A quarterly, annual or notice deadline that a release left open
// stays open until the Manager user completes it on the compliance page
// (release is the only automatic closer; emails sent later do not close
// it). TAX_K1: delivered still means emailed; with `email`, the email job
// closes the year's K-1 deadlines once the last holder of the year has been
// emailed its K-1 (k1-coverage.ts), as after any K-1 email. Without email
// the added K-1 holders count only once they are emailed.
//
// After commit: one `governance.report-email` job per NEW row (seq 0) when
// `email`; invitation emails. A failed emit is logged (the rows exist;
// `resend` with scope NOT_EMAILED re-queues).

export interface AddRecipientsResult {
  publicId: string;
  /** The rows created, in register order. */
  added: { recipientId: string; stakeholderId: string; name: string }[];
  /** Requested holders that were already recipients (left unchanged). */
  alreadyRecipients: string[];
  emailed: boolean;
  /** Report emails handed to the queue. */
  queued: number;
  warnings: AudienceWarning[];
  invitations: InvitationLine[];
  invitationsQueued: number;
}

export const addRecipientsProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportAddRecipientsSchema)
  .mutation(async ({ ctx, input }): Promise<AddRecipientsResult> => {
    const inviting = input.inviteMissing === true;
    // Before anything is written.
    if (inviting) assertMayInvite(ctx.permissions);
    if (input.email || inviting) assertMailDeliverable("MEMBER_EMAIL");
    const companyId = ctx.membership.companyId;
    const memberId = ctx.membership.memberId;
    const userName = ctx.session.user.name ?? "A user";
    const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
    const now = new Date();

    const result = await ctx.db.$transaction(
      async (tx) => {
        const ref = await findReportRef(tx, companyId, input.publicId);
        await lockCompanyLedgerAndUnitClasses(tx, companyId);
        await lockReport(tx, ref.id);
        const report = await tx.memberReport.findFirst({
          where: { id: ref.id, companyId },
        });
        if (!report) reportNotFound();
        if (report.status !== "SENT") {
          badRequest("Recipients can be added only to a released report.");
        }
        if (input.email && report.unpublishedAt !== null) {
          badRequest(UNPUBLISHED_EMAIL_REFUSAL);
        }
        const type = asReportType(report.type);

        const audience = await loadAudienceContext(
          tx,
          companyId,
          report,
          todayInZone(now, zone),
        );
        const byId = new Map(audience.holders.map((h) => [h.stakeholderId, h]));
        const existing = await tx.memberReportRecipient.findMany({
          where: { reportId: report.id, companyId },
          select: { stakeholderId: true },
        });
        const plan = planAddRecipients(
          type,
          input.stakeholderIds,
          audience.holders,
          new Set(existing.map((r) => r.stakeholderId)),
          {
            noticeKind: report.noticeKind,
            transferorId: audience.transferorId,
            email: input.email,
          },
        );
        if (plan.refusals.length > 0) {
          badRequest(refusalMessage(plan.refusals, (id) => byId.get(id)?.name));
        }
        const adding = new Set(plan.newIds);
        // In the order of the register (name, then id), as release.
        const holders = audience.holders.filter((h) =>
          adding.has(h.stakeholderId),
        );

        if (holders.length > 0) {
          await tx.memberReportRecipient.createMany({
            data: holders.map((h) => ({
              reportId: report.id,
              companyId,
              stakeholderId: h.stakeholderId,
              name: h.name,
              email: h.noticeEmail,
              tokenExpiresAt: reportTokenExpiry(now),
              addedById: memberId,
            })),
            // Backstop of @@unique([reportId, stakeholderId]); the report
            // lock already serialises additions.
            skipDuplicates: true,
          });
        }
        const rows =
          holders.length === 0
            ? []
            : await tx.memberReportRecipient.findMany({
                where: {
                  reportId: report.id,
                  companyId,
                  stakeholderId: { in: holders.map((h) => h.stakeholderId) },
                },
                orderBy: [{ name: "asc" }, { id: "asc" }],
                select: { id: true, stakeholderId: true, name: true },
              });

        let invitations: InvitationRun | null = null;
        if (inviting && holders.length > 0) {
          invitations = await inviteSelectedHolders(tx, {
            companyId,
            invitedById: memberId,
            candidates: holders,
            audit: {
              actorUserId: ctx.session.user.id,
              actorName: userName,
              ...auditContext(ctx),
            },
            now,
          });
        }

        if (rows.length > 0) {
          const title =
            readFrozenContent(report.frozenContent)?.title ?? report.title;
          const invited = invitationSummary(invitations);
          await Audit.create(
            {
              action: "memberReport.recipients-added",
              companyId,
              actor: { type: "user", id: ctx.session.user.id },
              context: auditContext(ctx),
              target: [{ type: "memberReport", id: report.id }],
              summary: [
                `${userName} added ${rows.length} ${
                  rows.length === 1 ? "recipient" : "recipients"
                } to the report "${title}" (${rows.map((r) => r.name).join(", ")})`,
                input.email
                  ? "emailed"
                  : "not emailed (in the portal only once published)",
                "no deadline is closed by an addition",
                ...(invited !== null ? [invited] : []),
              ].join("; "),
            },
            tx,
          );
        }

        return {
          publicId: report.publicId,
          reportId: report.id,
          rows,
          alreadyRecipients: plan.alreadyRecipientIds,
          warnings: plan.warnings,
          invitations,
        };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );

    let queued = 0;
    if (input.email && result.rows.length > 0) {
      const ok = await emitAfterCommit(
        "member report emails",
        { reportId: result.reportId },
        () =>
          emitReportEmails(
            result.rows.map((r) => ({ recipientId: r.id, seq: 0 })),
          ),
      );
      if (ok) queued = result.rows.length;
    }
    const invitationsQueued = await queueInvitations(result.invitations);
    return {
      publicId: result.publicId,
      added: result.rows.map((r) => ({
        recipientId: r.id,
        stakeholderId: r.stakeholderId,
        name: r.name,
      })),
      alreadyRecipients: result.alreadyRecipients,
      emailed: input.email,
      queued,
      warnings: result.warnings,
      invitations: result.invitations?.lines ?? [],
      invitationsQueued,
    };
  });
