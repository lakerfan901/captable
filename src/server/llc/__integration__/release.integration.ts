/**
 * Release of member reports (04-investor-portal.md P17–P24, package P4a),
 * against the local database. Not part of `vitest run`. Run from the
 * repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/release.integration.ts
 *
 * Every company is named `zz-release-…`, every address is `@example.com`,
 * mail goes to the local mail catcher only, and every row created is deleted
 * at the end (harness.ts `cleanup`).
 *
 * BASELINE. `release.baseline.json` is what `memberReport.send` did BEFORE
 * the split (recorded with `RELEASE_BASELINE=record` on the commit before
 * P4a): for a quarterly report, a K-1 report created from its deadline and a
 * transfer notice, the report row, every recipient row, the compliance
 * deadlines, the books, the queued jobs, and the same after the emails went
 * out, with ids replaced by holder names and times made relative to the
 * report's `sentAt`. The default run builds the same fixtures and compares a
 * `release` to every current Member with email, and the legacy `send`
 * entry point, field by field with that record.
 */
import { writeFileSync } from "node:fs";
import type { Job } from "pg-boss";
import {
  reportEmailJob,
  reportEmailWorker,
} from "@/jobs/governance-report-email";
import { reportFileJob } from "@/jobs/governance-report-file";
import { fromDateOnly } from "@/lib/date-only";
import { todayInZone } from "@/lib/governance/dates";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  inTx,
  issueCommon,
  newMember,
  runScenarios,
  section,
  setCompanyPrefix,
  setToday,
  subscribe,
  type TestCompany,
  usd,
} from "./harness";

setCompanyPrefix("zz-release-");

const RECORD = process.env.RELEASE_BASELINE === "record";
const BASELINE_PATH = "src/server/llc/__integration__/release.baseline.json";

const realToday = (c: TestCompany) => todayInZone(new Date(), c.timezone);

const runReportJob = (recipientId: string, seq: number) =>
  reportEmailWorker.handler([
    { data: { recipientId, seq } } as unknown as Job<{
      recipientId: string;
      seq: number;
    }>,
  ]);

// pg-boss is not started in these scripts: the emits are captured instead
// (what the procedure asked the queue for), so "queued" can be asserted.
const emitted: { name: string; data: Record<string, unknown> }[] = [];
(reportEmailJob as { bulkEmit: unknown }).bulkEmit = (
  items: { data: Record<string, unknown> }[],
) => {
  for (const i of items) {
    emitted.push({ name: "governance.report-email", data: i.data });
  }
  return Promise.resolve();
};
(reportFileJob as { emit: unknown }).emit = (data: Record<string, unknown>) => {
  emitted.push({ name: "governance.report-file", data });
  return Promise.resolve();
};

const FIXED_FETCHED_AT = "2026-11-15T00:00:00.000Z";

function paragraph(text: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

/**
 * One LLC: A and B hold Preferred Units, C holds Common Units only, F is a
 * Financial-Interest-only holder with Units, P is a prospect.
 */
async function fixtureCompany(label: string) {
  const c = await createCompany(label);
  const A = await newMember(c, "A Preferred");
  const B = await newMember(c, "B Preferred");
  const C = await newMember(c, "C Common");
  const F = await newMember(c, "F Interest");
  const P = await newMember(c, "P Prospect");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-10",
  });
  await subscribe(c, B.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  await subscribe(c, F.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  await issueCommon(c, C.id, "100", "2026-11-11");
  setToday(realToday(c));
  await db.stakeholder.update({
    where: { id: F.id },
    data: { memberStatus: "FINANCIAL_INTEREST_ONLY" },
  });
  await db.stakeholder.update({
    where: { id: B.id },
    data: { noticeEmail: `  b.notice@example.com ` },
  });
  const admin = await createAdmin(c);
  const holders = new Map<string, string>([
    [A.id, "A"],
    [B.id, "B"],
    [C.id, "C"],
    [F.id, "F"],
    [P.id, "P"],
  ]);
  const emails = new Map<string, string>([
    [A.email, "A.email"],
    [C.email, "C.email"],
    [F.email, "F.email"],
    ["b.notice@example.com", "B.notice"],
  ]);
  const reports = createCallerFactory(memberReportRouter)(admin.context);
  const memberId = (admin.session.user as unknown as { memberId: string })
    .memberId;
  return { c, A, B, C, F, P, admin, holders, emails, reports, memberId };
}

type Fixture = Awaited<ReturnType<typeof fixtureCompany>>;

/** A Q3 2026 quarterly report, complete, with its QUARTERLY_REPORT deadline. */
async function quarterlyDraft(f: Fixture) {
  await db.complianceDeadline.create({
    data: {
      companyId: f.c.id,
      ruleKey: "QUARTERLY_REPORT",
      dedupeKey: "QUARTERLY_REPORT:2026Q3",
      title: "Q3 2026 report",
      dueOn: fromDateOnly("2026-11-14"),
      source: "RULE",
    },
  });
  const { publicId } = await f.reports.create({
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: 3,
  });
  const row = await db.memberReport.findFirstOrThrow({
    where: { publicId, companyId: f.c.id },
  });
  const figures = JSON.parse(JSON.stringify(row.figures)) as {
    utilization: { bps: number | null };
    source: { fetchedAt: string } | null;
    managerPayments: { confirmedNone: boolean };
  };
  figures.utilization.bps = 8_500;
  figures.managerPayments.confirmedNone = true;
  if (figures.source) figures.source.fetchedAt = FIXED_FETCHED_AT;
  await f.reports.update({
    publicId,
    title: "Q3 2026 report to Members",
    figures,
    commentary: [paragraph("Operations were steady in the quarter.")],
  });
  return publicId;
}

/** A FY2026 K-1 report created from K1_TARGET, with a K-1 for A, B, C and F. */
async function k1Draft(f: Fixture) {
  await inTx((tx) => syncComplianceDeadlines(tx, f.c.id, new Date()));
  const target = await db.complianceDeadline.findFirstOrThrow({
    where: { companyId: f.c.id, dedupeKey: "K1_TARGET:2026" },
    select: { id: true },
  });
  const { publicId } = await f.reports.create({
    type: "TAX_K1",
    fiscalYear: 2026,
    relatedType: "COMPLIANCE_DEADLINE",
    relatedId: target.id,
  });
  for (const h of [f.A, f.B, f.C, f.F]) {
    const bucket = await db.bucket.create({
      data: {
        name: `k1-${h.id}.pdf`,
        key: `${f.c.id}/zz-k1/${h.id}.pdf`,
        mimeType: "application/pdf",
        size: 1,
        tags: [],
      },
    });
    await f.reports.addAttachment({
      publicId,
      bucketId: bucket.id,
      name: `K-1 ${f.holders.get(h.id)}.pdf`,
      kind: "K1",
      stakeholderId: h.id,
    });
  }
  return publicId;
}

/** A copy of A's Transfer Notice (7.1), with its TRANSFER_NOTICE_COPY deadline. */
async function transferNoticeDraft(f: Fixture) {
  const { publicId } = await f.reports.create({
    type: "NOTICE",
    noticeKind: "TRANSFER_NOTICE_COPY",
  });
  const report = await db.memberReport.findFirstOrThrow({
    where: { publicId, companyId: f.c.id },
    select: { id: true },
  });
  const transfer = await db.unitTransfer.create({
    data: {
      publicId: `zz-release-${Math.random().toString(36).slice(2, 12)}`,
      companyId: f.c.id,
      kind: "VOLUNTARY",
      status: "OPEN",
      fromStakeholderId: f.A.id,
      unitClassId: f.c.preferredId,
      unitClassKind: "PREFERRED",
      units: "10",
      noticeReceivedOn: fromDateOnly("2026-11-12"),
      noticeCopyReportId: report.id,
      authorId: "release-integration",
    },
  });
  const deadline = await db.complianceDeadline.create({
    data: {
      companyId: f.c.id,
      ruleKey: "TRANSFER_NOTICE_COPY",
      dedupeKey: `TRANSFER_NOTICE_COPY:${transfer.id}`,
      title: "Copy of the Transfer Notice",
      dueOn: fromDateOnly("2026-11-19"),
      source: "TRANSFER",
      sourceType: "UNIT_TRANSFER",
      sourceId: transfer.id,
    },
  });
  await db.memberReport.update({
    where: { id: report.id },
    data: { relatedType: "COMPLIANCE_DEADLINE", relatedId: deadline.id },
  });
  await f.reports.update({
    publicId,
    title: "Copy of Transfer Notice",
    figures: {},
    commentary: [paragraph("A Preferred gave notice of a transfer.")],
  });
  return { publicId, transferId: transfer.id };
}

type Snapshot = Record<string, unknown>;

const relevantDeadline = (key: string) =>
  key === "QUARTERLY_REPORT:2026Q3" ||
  key.startsWith("K1_") ||
  key.startsWith("TRANSFER_NOTICE_COPY:");

/** The rows a send / release wrote, with ids and times normalised. */
async function snapshot(f: Fixture, publicId: string): Promise<Snapshot> {
  const report = await db.memberReport.findFirstOrThrow({
    where: { publicId, companyId: f.c.id },
  });
  const base = report.sentAt?.getTime() ?? 0;
  const recipients = await db.memberReportRecipient.findMany({
    where: { reportId: report.id, companyId: f.c.id },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const deadlines = await db.complianceDeadline.findMany({
    where: { companyId: f.c.id },
    orderBy: { dedupeKey: "asc" },
  });
  const term = await db.llcTerm.findUnique({ where: { companyId: f.c.id } });
  const ids = new Set(recipients.map((r) => r.id));
  const jobs = emitted
    .filter((j) =>
      j.name === "governance.report-email"
        ? ids.has(String(j.data.recipientId))
        : j.data.reportId === report.id,
    )
    .map((j) => j);
  const audits = await db.audit.findMany({
    where: {
      companyId: f.c.id,
      action: { in: ["memberReport.sent", "memberReport.released"] },
    },
    orderBy: { occurredAt: "asc" },
    select: { action: true, summary: true },
  });
  const recipientName = new Map(recipients.map((r) => [r.id, r.name]));
  const logs = await db.emailLog.findMany({
    where: { companyId: f.c.id, relatedId: report.id },
    orderBy: [{ toAddress: "asc" }],
    select: { kind: true, toAddress: true, status: true, stakeholderId: true },
  });
  const deadlineKey = (key: string) =>
    key.startsWith("TRANSFER_NOTICE_COPY:") ? "TRANSFER_NOTICE_COPY:*" : key;
  return {
    report: {
      status: report.status,
      sentAtSet: report.sentAt !== null,
      sentByAdmin: report.sentById === f.memberId,
      title: report.title,
      frozenHash: report.frozenHash,
      frozenContent: report.frozenContent,
    },
    recipients: recipients.map((r) => ({
      holder: f.holders.get(r.stakeholderId) ?? "?",
      name: r.name,
      email: f.emails.get(r.email) ?? `raw:${r.email}`,
      tokenVersion: r.tokenVersion,
      tokenTtlMs: r.tokenExpiresAt.getTime() - base,
      tokenRevoked: r.tokenRevokedAt !== null,
      emailed: r.sentAt !== null,
      sendCount: r.sendCount,
      emailLogSet: r.emailLogId !== null,
      firstViewedAt: r.firstViewedAt,
      viewCount: r.viewCount,
    })),
    // The deadlines a report can close; the others (generated from today's
    // date) must all stay untouched.
    otherDeadlinesTouched: deadlines.filter(
      (d) => !relevantDeadline(d.dedupeKey) && d.status !== "OPEN",
    ).length,
    deadlines: deadlines
      .filter((d) => relevantDeadline(d.dedupeKey))
      .map((d) => ({
        key: deadlineKey(d.dedupeKey),
        status: d.status,
        satisfiedByType: d.satisfiedByType,
        satisfiedByThisReport: d.satisfiedById === report.id,
        completedByAdmin: d.completedById === f.memberId,
        completedAtIsSentAt: d.completedAt?.getTime() === base,
      })),
    booksClosedThrough:
      term?.booksClosedThrough?.toISOString().slice(0, 10) ?? null,
    jobs: jobs
      .map((j) =>
        j.name === "governance.report-email"
          ? `${j.name}:${recipientName.get(String(j.data.recipientId))}:seq${String(j.data.seq)}`
          : `${j.name}:report`,
      )
      .sort(),
    audit: audits.map((a) => ({
      action: a.action,
      summary: (a.summary ?? "").replace(
        /TRANSFER_NOTICE_COPY:[a-z0-9]+/g,
        "TRANSFER_NOTICE_COPY:*",
      ),
    })),
    emailLog: logs.map((l) => ({
      kind: l.kind,
      to: f.emails.get(l.toAddress) ?? `raw:${l.toAddress}`,
      status: l.status,
      holder: l.stakeholderId ? (f.holders.get(l.stakeholderId) ?? "?") : null,
    })),
  };
}

/** Runs every queued email of the report by hand (the first email, seq 0). */
async function deliverAll(f: Fixture, publicId: string) {
  const report = await db.memberReport.findFirstOrThrow({
    where: { publicId, companyId: f.c.id },
    select: { id: true },
  });
  const rows = await db.memberReportRecipient.findMany({
    where: { reportId: report.id },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  for (const r of rows) await runReportJob(r.id, 0);
}

type Releaser = (f: Fixture, publicId: string) => Promise<unknown>;

const KINDS = {
  quarterly: quarterlyDraft,
  k1: k1Draft,
  transfer: async (f: Fixture) => (await transferNoticeDraft(f)).publicId,
} as const;

async function runCase(
  kind: keyof typeof KINDS,
  how: Releaser,
): Promise<{ released: Snapshot; delivered: Snapshot }> {
  const f = await fixtureCompany(`${kind}`);
  const publicId = await KINDS[kind](f);
  await how(f, publicId);
  const released = await snapshot(f, publicId);
  await deliverAll(f, publicId);
  const delivered = await snapshot(f, publicId);
  return { released, delivered };
}

const legacySend: Releaser = (f, publicId) => f.reports.send({ publicId });

async function record() {
  const out: Record<string, unknown> = {};
  for (const kind of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
    section(`record: send of the ${kind} fixture`);
    out[kind] = await runCase(kind, legacySend);
    check(`${kind} recorded`, true);
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);
}

await runScenarios(RECORD ? [["record baseline", record]] : []);

// Keep `eq` referenced for the comparison scenarios added with P4a.
void eq;
