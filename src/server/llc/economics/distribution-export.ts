import "server-only";

import type { DistributionTypeEnum } from "@prisma/client";
import { render } from "react-email";
import {
  DistributionNoticeEmail,
  type DistributionNoticeEmailProps,
  distributionNoticeSubject,
} from "@/emails/llc/DistributionNoticeEmail";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import { logger } from "@/lib/logger";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import type {
  PrismaTransactionalClient,
  TPrisma,
  TPrismaOrTransaction,
} from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import type { LedgerActor } from "@/server/llc/commitments";
import { unitsToWire } from "@/server/llc/serialize";
import { isMailCatcherConfigured, sendMail } from "@/server/mailer";
import { calendarDate, longDate } from "./call-notices.logic";
import {
  buildDistributionCsv,
  type DistributionCsvRow,
  distributionCsvFilename,
  noticeSkipReason,
} from "./distribution-export.logic";
import { conflict, lockCompanyLedger, notFound, ruleViolation } from "./scope";

/*
 * Distribution delivery (E17): member notices, the payment-list CSV and the
 * two operational "paid" columns. Nothing here changes an economic column.
 *
 * Once-only notices: each line is CLAIMED before its email is sent with a
 * single-row guarded write `update({ where: { id, noticeSentAt: null } })`
 * that sets `noticeSentAt` to a claim timestamp (noticeEmailLogId stays
 * null). Postgres re-checks the guard after any row-lock wait, so of two
 * concurrent sends exactly one claims the line (the other gets P2025 and
 * skips it). After the mail server accepts the email the claim is replaced by
 * the real `noticeSentAt` and `noticeEmailLogId`; if the send fails the claim
 * is released (guarded on the same claim timestamp). A crash between claim
 * and record leaves `noticeSentAt` set with no log id: the line is then
 * treated as sent (never emailed twice) and the email log is the record.
 */

type Tx = PrismaTransactionalClient;
type Reader = TPrismaOrTransaction;

const TYPE_LABEL: Record<DistributionTypeEnum, string> = {
  OPERATING: "Operating distribution",
  RETURN_OF_UNUSED_CAPITAL: "Return of unused capital",
  SALE_OR_LIQUIDATION: "Sale or liquidation distribution",
};

const MAIL_CATCHER_BLOCKED =
  "Email is not configured for real delivery. Set EMAIL_SERVER and EMAIL_FROM before sending distribution notices.";

async function audit(
  tx: Reader,
  actor: LedgerActor,
  companyId: string,
  action: AuditSchemaType["action"],
  target: AuditSchemaType["target"],
  summary: string,
): Promise<void> {
  await Audit.create(
    {
      action,
      companyId,
      actor: { type: "user", id: actor.userId },
      context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
      target,
      summary,
    },
    tx,
  );
}

/** Stakeholder.noticeEmail, or email when that is empty (null when both are blank) — as Call Notices. */
function noticeAddress(s: { email: string; noticeEmail: string | null }) {
  const a = s.noticeEmail?.trim() || s.email.trim();
  return a === "" ? null : a;
}

/** "250.000000" → "250", "2.169490" → "2.16949". */
function unitsText(decimal: string): string {
  return decimal.includes(".") ? decimal.replace(/\.?0+$/, "") : decimal;
}

function periodLabel(start: Date | null, end: Date): string {
  const e = calendarDate(toDateOnly(end));
  return start === null
    ? `the period ended ${e}`
    : `the period from ${calendarDate(toDateOnly(start))} to ${e}`;
}

/** A FINALIZED, non-reversal, non-reversed distribution of this company, with its lines. */
async function loadDeliverable(db: Reader, companyId: string, id: string) {
  const d = await db.distribution.findFirst({
    where: { id, companyId },
    include: { lines: { orderBy: [{ stakeholderId: "asc" }] } },
  });
  if (!d) notFound("Distribution");
  if (d.status !== "FINALIZED" || d.isReversal || d.number === null) {
    ruleViolation(
      d.isReversal
        ? "A reversal distribution has no notices or payments."
        : d.status === "REVERSED"
          ? "This distribution was reversed."
          : "Only a finalized distribution can be delivered.",
    );
  }
  return { ...d, number: d.number };
}

// ---------------------------------------------------------------------------
// Notices

export type NoticeLineResult = {
  lineId: string;
  stakeholderId: string;
  name: string;
  status: "SENT" | "SKIPPED" | "FAILED";
  reason?: string;
  emailLogId?: string | null;
};

const SKIP_TEXT = {
  ALREADY_SENT: "A notice was already sent for this line.",
  NOTHING_DISTRIBUTED: "Nothing was distributed to this member.",
  NO_EMAIL: "The member has no email address.",
} as const;

export async function sendDistributionNotices(
  db: TPrisma,
  i: {
    company: { id: string; name: string };
    actor: LedgerActor;
    manager: { name: string; email: string };
    id: string;
    lineIds?: readonly string[];
  },
): Promise<{ results: NoticeLineResult[] }> {
  const companyId = i.company.id;
  if (process.env.NODE_ENV === "production" && isMailCatcherConfigured()) {
    ruleViolation(MAIL_CATCHER_BLOCKED);
  }
  const d = await loadDeliverable(db, companyId, i.id);
  let lines = d.lines;
  if (i.lineIds) {
    const wanted = new Set(i.lineIds);
    lines = d.lines.filter((l) => wanted.has(l.id));
    if (lines.length !== wanted.size) notFound("Distribution line");
  }
  const people = new Map(
    (
      await db.stakeholder.findMany({
        where: { companyId, id: { in: lines.map((l) => l.stakeholderId) } },
        select: { id: true, name: true, email: true, noticeEmail: true },
      })
    ).map((s) => [s.id, s]),
  );
  const paymentDateLong = longDate(toDateOnly(d.paymentDate));
  const results: NoticeLineResult[] = [];
  const sorted = [...lines].sort((a, b) =>
    (people.get(a.stakeholderId)?.name ?? "").localeCompare(
      people.get(b.stakeholderId)?.name ?? "",
      "en",
    ),
  );

  for (const line of sorted) {
    const person = people.get(line.stakeholderId);
    const name = person?.name ?? "";
    const to = person ? noticeAddress(person) : null;
    const base = { lineId: line.id, stakeholderId: line.stakeholderId, name };
    const skip = noticeSkipReason({
      noticeSentAt: line.noticeSentAt,
      grossCents: line.grossCents,
      email: to,
    });
    if (skip !== null || to === null) {
      results.push({
        ...base,
        status: "SKIPPED",
        reason: SKIP_TEXT[skip ?? "NO_EMAIL"],
      });
      continue;
    }

    // Claim the line (single-row guarded write; P2025 → someone else has it).
    const claimAt = new Date();
    const claimed = await guardedUpdate(() =>
      db.distributionLine.update({
        where: {
          id: line.id,
          companyId,
          distributionId: d.id,
          noticeSentAt: null,
        },
        data: { noticeSentAt: claimAt },
        select: { id: true },
      }),
    );
    if (claimed === null) {
      results.push({
        ...base,
        status: "SKIPPED",
        reason: SKIP_TEXT.ALREADY_SENT,
      });
      continue;
    }

    const release = async () => {
      try {
        await guardedUpdate(() =>
          db.distributionLine.update({
            where: {
              id: line.id,
              companyId,
              noticeSentAt: claimAt,
              noticeEmailLogId: null,
            },
            data: { noticeSentAt: null },
            select: { id: true },
          }),
        );
      } catch (error) {
        logger.error(
          { err: error, companyId, lineId: line.id },
          "Distribution notice: could not release the claim on a line",
        );
      }
    };

    let email: { subject: string; html: string };
    try {
      const defaultOffset =
        line.defaultOffsetBalanceCents +
        line.defaultOffsetInterestCents +
        line.defaultOffsetCostsCents;
      const props: DistributionNoticeEmailProps = {
        companyName: i.company.name,
        memberName: name,
        distributionNumber: String(d.number),
        typeLabel: TYPE_LABEL[d.type],
        periodLabel: periodLabel(d.periodStart, d.periodEnd),
        paymentDateLong,
        tierC: formatCents(line.tierCCents),
        tierD: formatCents(line.tierDCents),
        tierE: formatCents(line.tierEPreferredCents + line.tierECommonCents),
        gross: formatCents(line.grossCents),
        defaultOffset: defaultOffset === 0n ? "" : formatCents(defaultOffset),
        taxAdvanceOffset:
          line.taxAdvanceOffsetCents === 0n
            ? ""
            : formatCents(line.taxAdvanceOffsetCents),
        net: formatCents(line.netCents),
        unpaidReturnAfter: formatCents(
          line.unpaidReturnBeforeCents - line.tierCCents,
        ),
        unreturnedAfter: formatCents(
          line.unreturnedBeforeCents - line.tierDCents,
        ),
        preferredUnits: unitsText(
          microUnitsToDecimalString(
            microUnitsFromDecimal(unitsToWire(line.preferredUnits)),
          ),
        ),
        reserveBalance: formatCents(d.reserveBalanceCents ?? 0n),
        managerName: i.manager.name,
        managerEmail: i.manager.email,
        isReturnOfUnusedCapital: d.type === "RETURN_OF_UNUSED_CAPITAL",
      };
      email = {
        subject: distributionNoticeSubject(props),
        html: await render(DistributionNoticeEmail(props)),
      };
    } catch (error) {
      logger.error(
        { err: error, companyId, lineId: line.id },
        "Distribution notice: the email could not be prepared",
      );
      await release();
      results.push({
        ...base,
        status: "FAILED",
        reason: "The email could not be prepared; nothing was sent.",
      });
      continue;
    }

    let sent: { emailLogId: string | null; sentAt: Date };
    try {
      sent = await sendMail(
        {
          to,
          subject: email.subject,
          html: email.html,
          headers: { "X-From-Name": i.company.name },
        },
        {
          kind: "llc.distribution-notice",
          companyId,
          stakeholderId: line.stakeholderId,
          relatedType: "distributionLine",
          relatedId: line.id,
        },
      );
    } catch (error) {
      logger.warn(
        { err: error, companyId, lineId: line.id },
        "Distribution notice: the mail server did not accept the email",
      );
      await release();
      results.push({
        ...base,
        status: "FAILED",
        reason: "The mail server did not accept the email; it can be retried.",
      });
      continue;
    }

    try {
      await db.$transaction(async (tx: Tx) => {
        await tx.distributionLine.update({
          where: { id: line.id, companyId, noticeSentAt: claimAt },
          data: {
            noticeSentAt: sent.sentAt,
            noticeEmailLogId: sent.emailLogId,
          },
          select: { id: true },
        });
        await audit(
          tx,
          i.actor,
          companyId,
          "distribution.notices-sent",
          [
            { type: "distribution", id: d.id },
            { type: "stakeholder", id: line.stakeholderId },
            ...(sent.emailLogId
              ? [{ type: "emailLog" as const, id: sent.emailLogId }]
              : []),
          ],
          `${i.actor.name} sent the notice of distribution No. ${d.number} to ${name} (${to}): ${formatCents(line.netCents)} net.`,
        );
      });
      results.push({ ...base, status: "SENT", emailLogId: sent.emailLogId });
    } catch (error) {
      // The email went out; the claim (noticeSentAt set) stays, so it is not resent.
      logger.error(
        { err: error, companyId, lineId: line.id, emailLogId: sent.emailLogId },
        "Distribution notice: the email was accepted but could not be recorded",
      );
      results.push({
        ...base,
        status: "SENT",
        emailLogId: sent.emailLogId,
        reason:
          "The email was sent, but recording its log id failed; the line is still marked as sent.",
      });
    }
  }
  return { results };
}

// ---------------------------------------------------------------------------
// CSV

export async function exportDistributionCsv(
  tx: Tx,
  i: { company: { id: string; name: string }; actor: LedgerActor; id: string },
): Promise<{ filename: string; csv: string }> {
  const companyId = i.company.id;
  const d = await loadDeliverable(tx, companyId, i.id);
  const people = new Map(
    (
      await tx.stakeholder.findMany({
        where: { companyId, id: { in: d.lines.map((l) => l.stakeholderId) } },
        select: { id: true, name: true, email: true, noticeEmail: true },
      })
    ).map((s) => [s.id, s]),
  );
  const paymentDate = toDateOnly(d.paymentDate);
  const rows: DistributionCsvRow[] = d.lines.map((l) => {
    const p = people.get(l.stakeholderId);
    return {
      distributionNumber: d.number,
      paymentDate,
      stakeholderId: l.stakeholderId,
      memberName: p?.name ?? "",
      email: (p && noticeAddress(p)) ?? "",
      preferredUnits: microUnitsFromDecimal(unitsToWire(l.preferredUnits)),
      gross: l.grossCents,
      tierC: l.tierCCents,
      tierD: l.tierDCents,
      tierE: l.tierEPreferredCents + l.tierECommonCents,
      defaultOffset:
        l.defaultOffsetBalanceCents +
        l.defaultOffsetInterestCents +
        l.defaultOffsetCostsCents,
      taxAdvanceOffset: l.taxAdvanceOffsetCents,
      net: l.netCents,
      companyName: i.company.name,
    };
  });
  await audit(
    tx,
    i.actor,
    companyId,
    "distribution.exported",
    [{ type: "distribution", id: d.id }],
    `${i.actor.name} exported the payment list of distribution No. ${d.number} (${rows.length} lines).`,
  );
  return {
    filename: distributionCsvFilename(d.number, paymentDate),
    csv: buildDistributionCsv(rows),
  };
}

// ---------------------------------------------------------------------------
// Payment marking

export async function markDistributionLinesPaid(
  tx: Tx,
  i: {
    company: { id: string };
    actor: LedgerActor;
    id: string;
    lineIds: readonly string[];
    paidOn: string;
    paymentReference: string | null;
  },
): Promise<{ updated: number }> {
  const companyId = i.company.id;
  // Serialised with finalize / reverse (they take the same lock first).
  await lockCompanyLedger(tx, companyId);
  const d = await loadDeliverable(tx, companyId, i.id);
  const byId = new Map(d.lines.map((l) => [l.id, l]));
  const wanted = [...new Set(i.lineIds)];
  for (const id of wanted) {
    const line = byId.get(id);
    if (!line) notFound("Distribution line");
    if (line.netCents <= 0n) {
      ruleViolation(
        "Only a line with a net amount payable can be marked paid.",
      );
    }
  }
  for (const id of wanted) {
    const row = await guardedUpdate(() =>
      tx.distributionLine.update({
        where: { id, companyId, distributionId: d.id, netCents: { gt: 0n } },
        data: {
          paidOn: fromDateOnly(i.paidOn),
          paymentReference: i.paymentReference,
        },
        select: { id: true },
      }),
    );
    if (row === null) conflict("A line changed; refresh the page.");
  }
  await audit(
    tx,
    i.actor,
    companyId,
    "distribution.line-paid",
    [
      { type: "distribution", id: d.id },
      ...wanted.map((id) => ({
        type: "stakeholder" as const,
        id: byId.get(id)?.stakeholderId ?? null,
      })),
    ],
    `${i.actor.name} marked ${wanted.length} line(s) of distribution No. ${d.number} paid on ${i.paidOn}${i.paymentReference ? ` (reference ${i.paymentReference})` : ""}.`,
  );
  return { updated: wanted.length };
}
