import { render } from "react-email";
import { z } from "zod";
import ComplianceDigestEmail, {
  type ComplianceDigestItem,
  complianceDigestSubject,
  sortDigestItems,
} from "@/emails/ComplianceDigestEmail";
import { env } from "@/env";
import {
  addDays,
  daysBetween,
  reminderBucket,
  utcDateToYmd,
  type Ymd,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";
import {
  type SyncResult,
  syncComplianceDeadlines,
} from "@/server/governance/compliance";
import { guardedWrite } from "@/server/governance/guarded";
import { listManagerUsers } from "@/server/governance/recipients";
import { currentMailDelivery } from "@/server/mail-delivery";
import { sendMail } from "@/server/mailer";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";

// Daily compliance sweep (03-governance.md G14), 07:00 America/Denver.
// For each LLC company, on its own (a failure is logged and does not stop
// the others; the job throws at the end so pg-boss retries):
// 1. `syncComplianceDeadlines` in its own transaction (it reads the whole
//    ledger, hence the 30 s timeout). It returns the company's `today`.
// 2. OPEN deadlines (every source) whose `reminderBucket(dueOn, today)` is
//    not yet in `remindedBuckets`.
// 3. If any: ONE digest per Manager user (`listManagerUsers`, never Members),
//    through the logged `sendMail`. Only AFTER at least one digest left is
//    each included deadline marked (`remindedBuckets` + bucket,
//    `lastReminderAt`), one guarded single-row update each that re-checks
//    it is still OPEN, still on the date the digest showed and not yet
//    marked. A second run the same day therefore finds nothing to send, and
//    a retry after a failed send sends again.
//    Nothing is marked when no Manager user has an address, when every send
//    failed, or while production mail goes only to the bundled mail catcher
//    (the digest is then skipped: the catcher accepts the message, so it
//    would be recorded as reminded with nobody reading it; the next sweep
//    after real delivery is configured sends the current bucket).
//    When some Manager users got it and others did not, the deadlines are
//    marked (a dead address must not repeat the digest daily for the
//    others) and the failure is logged and counted.
// The sweep writes no Audit rows (the plan names none for it); sends are in
// EmailLog (kind "compliance.digest", relatedType "complianceDeadline").

const JOB_NAME = "governance.daily-sweep";
export const COMPLIANCE_DIGEST_KIND = "compliance.digest";
/** The furthest bucket is 30 days out (`reminderBucket`). */
const REMINDER_WINDOW_DAYS = 30;

const log = logger.child({ module: "governance-daily-sweep" });

const config = defineWorkerConfig({
  name: JOB_NAME,
  schema: z.object({}),
});

export const dailySweepJob = defineJob(config);

export type DigestDelivery =
  | "SENT"
  | "PARTIAL"
  | "NOTHING_DUE"
  | "NO_MANAGERS"
  | "MAIL_BLOCKED"
  | "FAILED";

export interface CompanySweepResult {
  companyId: string;
  companyName: string;
  sync: SyncResult | null;
  /** Deadlines due a reminder today, with their bucket. */
  due: { id: string; dueOn: Ymd; title: string; bucket: number }[];
  subject: string | null;
  /** Manager addresses the digest was sent to (or would have been). */
  recipients: string[];
  delivery: DigestDelivery;
  /** Deadlines marked as reminded. */
  marked: number;
  error: string | null;
}

export interface DailySweepOptions {
  /** Replaces `sendMail` (local scripted runs only). */
  send?: typeof sendMail;
}

/** Fills `result` as it goes, so a failure still reports what was done. */
async function sweepCompany(
  company: { id: string; name: string; publicId: string },
  now: Date,
  options: DailySweepOptions,
  result: CompanySweepResult,
): Promise<void> {
  // 1. Sync.
  const sync = await db.$transaction(
    (tx) => syncComplianceDeadlines(tx, company.id, now),
    { maxWait: 10_000, timeout: 30_000 },
  );
  result.sync = sync;
  const { today } = sync;

  // 2. Deadlines due a reminder today.
  const open = await db.complianceDeadline.findMany({
    where: {
      companyId: company.id,
      status: "OPEN",
      dueOn: { lte: ymdToUtcDate(addDays(today, REMINDER_WINDOW_DAYS)) },
    },
    select: {
      id: true,
      dueOn: true,
      title: true,
      section: true,
      remindedBuckets: true,
    },
    orderBy: [{ dueOn: "asc" }, { id: "asc" }],
  });
  const due = open.flatMap((d) => {
    const dueOn = utcDateToYmd(d.dueOn);
    const bucket = reminderBucket(dueOn, today);
    if (bucket === null || d.remindedBuckets.includes(bucket)) return [];
    return [{ ...d, dueOn, bucket }];
  });
  result.due = due.map(({ id, dueOn, title, bucket }) => ({
    id,
    dueOn,
    title,
    bucket,
  }));
  if (due.length === 0) return;

  const managers = await listManagerUsers(db, company.id);
  result.recipients = managers.map((m) => m.email);
  const subject = complianceDigestSubject(company.name, due.length);
  result.subject = subject;
  if (managers.length === 0) {
    result.delivery = "NO_MANAGERS";
    log.warn(
      { companyId: company.id, due: due.length },
      "Compliance digest not sent: the company has no Manager user with an email address",
    );
    return;
  }
  const blocked = currentMailDelivery("MEMBER_EMAIL").blockedReason;
  if (blocked !== null) {
    result.delivery = "MAIL_BLOCKED";
    log.warn(
      { companyId: company.id, due: due.length },
      "Compliance digest skipped: production email only reaches the local mail catcher",
    );
    return;
  }

  // 3. Send, then mark.
  const items: ComplianceDigestItem[] = sortDigestItems(
    due.map((d) => ({
      dueOn: d.dueOn,
      title: d.title,
      section: d.section,
      daysLeft: daysBetween(today, d.dueOn),
    })),
  );
  const link = `${env.NEXT_PUBLIC_BASE_URL}/${company.publicId}/compliance`;
  const send = options.send ?? sendMail;
  let sent = 0;
  const failures: unknown[] = [];
  for (const manager of managers) {
    try {
      const html = await render(
        ComplianceDigestEmail({
          companyName: company.name,
          recipientName: manager.name,
          items,
          link,
        }),
      );
      await send(
        {
          to: manager.email,
          subject,
          html,
          headers: { "X-From-Name": company.name },
        },
        {
          kind: COMPLIANCE_DIGEST_KIND,
          companyId: company.id,
          relatedType: "complianceDeadline",
          relatedId: due[0]?.id,
        },
      );
      sent++;
    } catch (error) {
      failures.push(error);
      log.error(
        { err: error, companyId: company.id, memberId: manager.memberId },
        "Compliance digest could not be sent to a Manager user",
      );
    }
  }
  if (sent === 0) {
    // Nothing is marked: the next run (pg-boss retry) sends again.
    throw failures[0] ?? new Error("Compliance digest not sent");
  }

  for (const d of due) {
    const ok = await guardedWrite(() =>
      db.complianceDeadline.update({
        where: {
          id: d.id,
          companyId: company.id,
          status: "OPEN",
          dueOn: ymdToUtcDate(d.dueOn),
          NOT: { remindedBuckets: { has: d.bucket } },
        },
        data: { remindedBuckets: { push: d.bucket }, lastReminderAt: now },
        select: { id: true },
      }),
    );
    if (ok) result.marked++;
  }

  if (failures.length > 0) {
    result.delivery = "PARTIAL";
    result.error = `${failures.length} of ${managers.length} digest(s) could not be sent`;
  } else {
    result.delivery = "SENT";
  }
}

function errorMessage(error: unknown): string {
  // Connection errors (e.g. ECONNREFUSED) can have an empty message.
  const code = (error as { code?: unknown } | null)?.code;
  return (
    (error instanceof Error && error.message) ||
    (typeof code === "string" ? code : "") ||
    String(error)
  );
}

/**
 * Runs the sweep for every LLC company. Never throws for one company; the
 * caller decides what a failed company means (the worker rethrows).
 */
export async function runDailySweep(
  now: Date,
  options: DailySweepOptions = {},
): Promise<CompanySweepResult[]> {
  const companies = await db.company.findMany({
    where: { entityType: "LLC" },
    select: { id: true, name: true, publicId: true },
    orderBy: { createdAt: "asc" },
  });
  const results: CompanySweepResult[] = [];
  for (const company of companies) {
    const result: CompanySweepResult = {
      companyId: company.id,
      companyName: company.name,
      sync: null,
      due: [],
      subject: null,
      recipients: [],
      delivery: "NOTHING_DUE",
      marked: 0,
      error: null,
    };
    try {
      await sweepCompany(company, now, options, result);
    } catch (error) {
      log.error(
        { err: error, companyId: company.id },
        "Daily compliance sweep failed for a company",
      );
      result.delivery = "FAILED";
      result.error = errorMessage(error);
    }
    results.push(result);
  }
  return results;
}

export const dailySweepWorker = defineWorker(config, async () => {
  const results = await runDailySweep(new Date());
  const failed = results.filter(
    (r) => r.delivery === "FAILED" || r.delivery === "PARTIAL",
  );
  log.info(
    {
      companies: results.length,
      digests: results.filter(
        (r) => r.delivery === "SENT" || r.delivery === "PARTIAL",
      ).length,
      failed: failed.length,
    },
    "Daily compliance sweep done",
  );
  if (failed.length > 0) {
    // Retried by pg-boss: the sync is idempotent and deadlines already marked
    // are not sent again.
    throw new Error(
      `Daily compliance sweep failed for ${failed.length} compan${failed.length === 1 ? "y" : "ies"}`,
    );
  }
});
