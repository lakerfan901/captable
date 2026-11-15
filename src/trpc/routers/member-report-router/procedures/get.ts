import { TRPCError } from "@trpc/server";
import { REPORT_DELIVERY_KIND } from "@/jobs/governance-report-email";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { canRemoveRecipient } from "@/lib/governance/recipient-core";
import {
  EMPTY_FIGURES,
  reportChecklist,
} from "@/lib/governance/report-figures";
import {
  isDocEmpty,
  normalizeBlocks,
  type RichDoc,
} from "@/lib/governance/rich-doc";
import { isInlineContentType } from "@/lib/inline-content-type";
import { loadK1Coverage } from "@/server/governance/k1-coverage";
import { currentMailDelivery } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportGetSchema } from "../schema";
import { deriveAudience, loadPortalStates } from "./audience";
import {
  asReportType,
  readFrozenContent,
  storedFigures,
  ymdOrNull,
} from "./shared";

// memberReport.get (03-governance.md G12): one report with its checklist,
// attachments (with the holder's name), recipients (link state, email log
// state) and, for a DRAFT, the candidates the server would send it to.
//
// After release (formerly "send"), the title, figures and text shown are the
// ones frozen at release. The candidates are the default audience of the
// release picker (`deriveAudience`; `audienceOptions` lists every holder).
// `report.sentAt` is the release time; each recipient's `emailedAt` is its
// email (04-investor-portal.md 5.5).

export type ReportLinkState = "ACTIVE" | "EXPIRED" | "REVOKED";
export type ReportEmailState = "NOT_SENT" | "SENT" | "FAILED" | "BOUNCED";

export const getProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberReportGetSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const row = await ctx.db.memberReport.findFirst({
      where: { publicId: input.publicId, companyId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Report not found." });
    }
    const type = asReportType(row.type);

    const [attachments, recipients, emails] = await Promise.all([
      ctx.db.memberReportAttachment.findMany({
        where: { reportId: row.id, companyId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          kind: true,
          name: true,
          stakeholderId: true,
          createdAt: true,
          bucketId: true,
        },
      }),
      ctx.db.memberReportRecipient.findMany({
        where: { reportId: row.id, companyId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: {
          id: true,
          stakeholderId: true,
          name: true,
          email: true,
          tokenVersion: true,
          tokenExpiresAt: true,
          tokenRevokedAt: true,
          sentAt: true,
          sendCount: true,
          emailLogId: true,
          firstViewedAt: true,
          viewCount: true,
          addedById: true,
        },
      }),
      ctx.db.emailLog.findMany({
        where: { companyId, relatedType: "memberReport", relatedId: row.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          stakeholderId: true,
          toAddress: true,
          kind: true,
          status: true,
          sentAt: true,
          bounceState: true,
          createdAt: true,
        },
      }),
    ]);

    // Portal (04-investor-portal.md 5.5, package P4a): the holder's portal
    // state, its first portal view of this report, and whether anything of
    // this report was opened in the portal. Log convention (written by P5a):
    // REPORT_VIEWED / REPORT_EXPORTED carry targetType "memberReport" and
    // targetId = MemberReport.id; REPORT_FILE_OPENED carries targetType
    // "memberReportAttachment" and targetId = MemberReportAttachment.id.
    const recipientHolderIds = recipients.map((r) => r.stakeholderId);
    const [portalStates, portalLogs] = await Promise.all([
      loadPortalStates(ctx.db, companyId, recipientHolderIds),
      recipientHolderIds.length === 0
        ? []
        : ctx.db.portalAccessLog.findMany({
            where: {
              companyId,
              stakeholderId: { in: recipientHolderIds },
              OR: [
                { targetType: "memberReport", targetId: row.id },
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
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { stakeholderId: true, event: true, createdAt: true },
          }),
    ]);
    const portalFirstViewed = new Map<string, Date>();
    const portalTouched = new Set<string>();
    for (const l of portalLogs) {
      if (l.stakeholderId === null) continue;
      portalTouched.add(l.stakeholderId);
      if (
        l.event === "REPORT_VIEWED" &&
        !portalFirstViewed.has(l.stakeholderId)
      ) {
        portalFirstViewed.set(l.stakeholderId, l.createdAt);
      }
    }

    const holderIds = [
      ...new Set(
        attachments.flatMap((a) => (a.stakeholderId ? [a.stakeholderId] : [])),
      ),
    ];
    const holders =
      holderIds.length === 0
        ? []
        : await ctx.db.stakeholder.findMany({
            where: { id: { in: holderIds }, companyId },
            select: { id: true, name: true },
          });
    const holderName = new Map(holders.map((h) => [h.id, h.name]));

    // Content: live while DRAFT, frozen after send.
    const frozen =
      row.status === "SENT" ? readFrozenContent(row.frozenContent) : null;
    const figures =
      row.status === "SENT"
        ? (frozen?.figures ?? null)
        : storedFigures(row.type, row.figures);
    let doc: RichDoc = [];
    if (frozen) {
      doc = frozen.doc;
    } else {
      const normalized = normalizeBlocks(row.commentary);
      doc = normalized.ok ? normalized.doc : [];
    }
    const inlineBuckets = new Set(
      (
        await ctx.db.bucket.findMany({
          where: { id: { in: attachments.map((a) => a.bucketId) } },
          select: { id: true, mimeType: true },
        })
      )
        .filter((b) => isInlineContentType(b.mimeType))
        .map((b) => b.id),
    );
    // Unparsable figures count as empty (every figure item not ok).
    const checklist = reportChecklist(
      type,
      figures ?? EMPTY_FIGURES,
      attachments,
      isDocEmpty(doc),
    );

    // Latest delivery email per stakeholder.
    const latestDelivery = new Map<string, (typeof emails)[number]>();
    for (const e of emails) {
      if (e.kind !== REPORT_DELIVERY_KIND || !e.stakeholderId) continue;
      if (!latestDelivery.has(e.stakeholderId)) {
        latestDelivery.set(e.stakeholderId, e);
      }
    }

    let candidates: {
      stakeholderId: string;
      name: string;
      email: string;
      memberStatus: string;
      hasK1: boolean;
    }[] = [];
    let candidatesProblem: string | null = null;
    if (row.status === "DRAFT") {
      if (type === "TAX_K1") {
        const k1For = new Set(
          attachments.flatMap((a) =>
            a.kind === "K1" && a.stakeholderId ? [a.stakeholderId] : [],
          ),
        );
        const eligible = await ctx.db.stakeholder.findMany({
          where: {
            companyId,
            memberStatus: { in: ["MEMBER", "FINANCIAL_INTEREST_ONLY"] },
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: {
            id: true,
            name: true,
            email: true,
            noticeEmail: true,
            memberStatus: true,
          },
        });
        candidates = eligible.map((s) => ({
          stakeholderId: s.id,
          name: s.name,
          email: (s.noticeEmail ?? s.email).trim(),
          memberStatus: s.memberStatus,
          hasK1: k1For.has(s.id),
        }));
      } else {
        const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
        const audience = await deriveAudience(
          ctx.db,
          companyId,
          row,
          todayInZone(now, zone),
        );
        if (audience.ok) {
          candidates = audience.members.map((m) => ({
            ...m,
            memberStatus: "MEMBER",
            hasK1: false,
          }));
        } else {
          candidatesProblem = audience.problem;
        }
      }
    }

    // TAX_K1: who needs a K-1 for the fiscal year and who has one (R25,
    // R22a). The year's K-1 deadlines are done only when `complete`.
    let k1Coverage: {
      fiscalYear: number;
      complete: boolean;
      missing: string[];
      holders: {
        stakeholderId: string;
        name: string;
        /** Recipient of a SENT K-1 report of the year, email accepted. */
        delivered: boolean;
        /** Recipient whose K-1 email has not gone out yet. */
        queued: boolean;
        /** A K-1 for this holder is attached to THIS report. */
        attachedHere: boolean;
      }[];
    } | null = null;
    if (type === "TAX_K1" && row.fiscalYear) {
      const coverage = await loadK1Coverage(ctx.db, companyId, row.fiscalYear);
      const attachedHere = new Set(
        attachments.flatMap((a) =>
          a.kind === "K1" && a.stakeholderId ? [a.stakeholderId] : [],
        ),
      );
      k1Coverage = {
        fiscalYear: coverage.fiscalYear,
        complete: coverage.complete,
        missing: coverage.missing,
        holders: coverage.needed.map((h) => ({
          ...h,
          attachedHere: attachedHere.has(h.stakeholderId),
        })),
      };
    }

    return {
      k1Coverage,
      // Production with the mail catcher: `send` refuses; elsewhere "Test mode".
      mailDelivery: currentMailDelivery("REPORT"),
      report: {
        publicId: row.publicId,
        type,
        status: row.status,
        title: frozen?.title ?? row.title,
        fiscalYear: row.fiscalYear,
        fiscalQuarter: row.fiscalQuarter,
        periodStart: ymdOrNull(row.periodStart),
        periodEnd: ymdOrNull(row.periodEnd),
        noticeKind: row.noticeKind,
        relatedType: row.relatedType,
        relatedId: row.relatedId,
        /** Parsed figures (QUARTERLY / ANNUAL); null when absent or unparsable. */
        figures: type === "QUARTERLY" || type === "ANNUAL" ? figures : null,
        /** The stored BlockNote blocks (for the editor while DRAFT). */
        commentary: row.commentary,
        /** The normalized document (live while DRAFT, frozen after send). */
        doc,
        frozenHash: row.frozenHash,
        dueOn: ymdOrNull(row.dueOn),
        /**
         * When the report was RELEASED (frozen, recipients fixed). It is not
         * an email date: since the investor portal a report can be released
         * without email; each recipient's `emailedAt` says when it was
         * emailed.
         */
        sentAt: row.sentAt,
        sentById: row.sentById,
        /** null: released before the portal existed (never published). */
        publishedAt: row.publishedAt,
        publishedById: row.publishedById,
        /** Set while the report is withdrawn from the portal (P24). */
        unpublishedAt: row.unpublishedAt,
        unpublishedById: row.unpublishedById,
        authorId: row.authorId,
        filedDocumentId: row.filedDocumentId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      checklist,
      attachments: attachments.map(({ bucketId, ...a }) => ({
        ...a,
        // PDF / image: opens in a tab; anything else downloads.
        inline: inlineBuckets.has(bucketId),
        holderName: a.stakeholderId
          ? (holderName.get(a.stakeholderId) ?? null)
          : null,
      })),
      recipients: recipients.map((r) => {
        const email = latestDelivery.get(r.stakeholderId);
        let emailState: ReportEmailState = "NOT_SENT";
        if (email) {
          emailState =
            email.status === "FAILED"
              ? "FAILED"
              : email.bounceState === "BOUNCED"
                ? "BOUNCED"
                : "SENT";
        }
        const linkState: ReportLinkState =
          r.tokenRevokedAt !== null
            ? "REVOKED"
            : r.tokenExpiresAt.getTime() < now.getTime()
              ? "EXPIRED"
              : "ACTIVE";
        return {
          id: r.id,
          stakeholderId: r.stakeholderId,
          name: r.name,
          email: r.email,
          tokenVersion: r.tokenVersion,
          tokenExpiresAt: r.tokenExpiresAt,
          linkState,
          /** First email accepted by the mail server; null: never emailed. */
          sentAt: r.sentAt,
          /** The same as `sentAt`, under the name the portal plan uses. */
          emailedAt: r.sentAt,
          sendCount: r.sendCount,
          /** First view through the emailed link (token page). */
          firstViewedAt: r.firstViewedAt,
          viewCount: r.viewCount,
          emailState,
          lastEmailAt: email?.sentAt ?? email?.createdAt ?? null,
          /** Member.id that confirmed this holder; null before the portal. */
          addedById: r.addedById,
          portal: portalStates.get(r.stakeholderId) ?? "NONE",
          portalFirstViewedAt: portalFirstViewed.get(r.stakeholderId) ?? null,
          /**
           * Removal is allowed only for a recipient never emailed (no claim
           * ever taken), never opened through the link and with no portal
           * log row for this report (P19, 5.5): the rule of
           * `memberReport.removeRecipient` (`removalRefusal`).
           */
          canRemove:
            row.status === "SENT" &&
            canRemoveRecipient({
              ...r,
              portalTouched: portalTouched.has(r.stakeholderId),
            }),
          /** "" for a portal-only recipient without a notice address: it cannot be emailed until its link is replaced with an address. */
          hasAddress: r.email.trim() !== "",
        };
      }),
      emails,
      candidates,
      candidatesProblem,
    };
  });
