import { TRPCError } from "@trpc/server";
import { REPORT_DELIVERY_KIND } from "@/jobs/governance-report-email";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
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
import { currentMailDelivery } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportGetSchema } from "../schema";
import { deriveAudience } from "./audience";
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
// After send, the title, figures and text shown are the ones frozen at send.

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

    return {
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
        sentAt: row.sentAt,
        sentById: row.sentById,
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
          sentAt: r.sentAt,
          sendCount: r.sendCount,
          firstViewedAt: r.firstViewedAt,
          viewCount: r.viewCount,
          emailState,
          lastEmailAt: email?.sentAt ?? email?.createdAt ?? null,
        };
      }),
      emails,
      candidates,
      candidatesProblem,
    };
  });
