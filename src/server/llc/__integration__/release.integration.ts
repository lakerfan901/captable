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
import { readFileSync, writeFileSync } from "node:fs";
import type { Job } from "pg-boss";
import {
  reportEmailJob,
  reportEmailWorker,
} from "@/jobs/governance-report-email";
import { reportFileJob } from "@/jobs/governance-report-file";
import { fromDateOnly } from "@/lib/date-only";
import { todayInZone } from "@/lib/governance/dates";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
import { loadK1Coverage } from "@/server/governance/k1-coverage";
import { signReportToken } from "@/server/governance/tokens";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { memberReportViewRouter } from "@/trpc/routers/member-report-view-router/router";
import {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  errorOf,
  expectRefused,
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

// `Bucket` has no `companyId` column, so the harness cleanup cannot see the
// K-1 files: they are tracked here and deleted by the last scenario.
const createdBucketIds: string[] = [];

async function testBucket(key: string) {
  const bucket = await db.bucket.create({
    data: {
      name: key.split("/").pop() ?? "k1.pdf",
      key,
      mimeType: "application/pdf",
      size: 1,
      tags: [],
    },
  });
  createdBucketIds.push(bucket.id);
  return bucket;
}

async function deleteBuckets() {
  section("cleanup: the K-1 files of this run");
  await db.memberReportAttachment.deleteMany({
    where: { bucketId: { in: createdBucketIds } },
  });
  await db.bucket.deleteMany({ where: { id: { in: createdBucketIds } } });
  eq(
    "no bucket of this run is left",
    await db.bucket.count({ where: { id: { in: createdBucketIds } } }),
    0,
  );
}

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
    const bucket = await testBucket(`${f.c.id}/zz-k1/${h.id}.pdf`);
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
    // Not in the baseline (columns of the investor portal).
    portal: {
      publishedAtIsSentAt:
        report.publishedAt !== null && report.publishedAt.getTime() === base,
      publishedByAdmin: report.publishedById === f.memberId,
      unpublished: report.unpublishedAt !== null,
      recipientsAddedByAdmin: recipients.every(
        (r) => r.addedById === f.memberId,
      ),
    },
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

async function runCase(kind: keyof typeof KINDS, how: Releaser) {
  const f = await fixtureCompany(`${kind}`);
  const publicId = await KINDS[kind](f);
  const draft = await f.reports.get({ publicId }).catch(() => null);
  const result = await how(f, publicId);
  const released = await snapshot(f, publicId);
  await deliverAll(f, publicId);
  const delivered = await snapshot(f, publicId);
  return { f, publicId, draft, result, released, delivered };
}

const legacySend: Releaser = (f, publicId) => f.reports.send({ publicId });

async function record() {
  const out: Record<string, unknown> = {};
  for (const kind of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
    section(`record: send of the ${kind} fixture`);
    const { released, delivered } = await runCase(kind, legacySend);
    out[kind] = { released, delivered };
    check(`${kind} recorded`, true);
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Comparison with the recorded `send`

/** The default preset of the picker: what "all current Members" ticks. */
async function defaultIds(f: Fixture, publicId: string): Promise<string[]> {
  const options = await f.reports.audienceOptions({ publicId });
  const preset = options.presets.find((p) => p.key === options.defaultPreset);
  return preset?.stakeholderIds ?? [];
}

const fullRelease: Releaser = async (f, publicId) =>
  f.reports.release({
    publicId,
    stakeholderIds: await defaultIds(f, publicId),
    email: true,
  });

/** The old audit summary from a release summary: "released" → "sent", names and "emailed" dropped. */
function asOldSummary(summary: string): string {
  return summary
    .replace(" released the report ", " sent the report ")
    .replace(/ (recipients?) \([^)]*\); emailed/, " $1");
}

function compareWithBaseline(
  label: string,
  actual: Snapshot,
  expected: Snapshot,
) {
  for (const key of Object.keys(expected)) {
    if (key === "audit") continue;
    eq(
      `${label}: ${key} as recorded`,
      JSON.stringify(actual[key]),
      JSON.stringify(expected[key]),
    );
  }
  const audit = actual.audit as { action: string; summary: string }[];
  const old = expected.audit as { action: string; summary: string }[];
  eq(`${label}: one audit row`, audit.length, old.length);
  eq(
    `${label}: audited as memberReport.released (was memberReport.sent)`,
    audit.map((a) => a.action).join(","),
    "memberReport.released",
  );
  eq(
    `${label}: the audit states the same facts (plus the names and "emailed")`,
    asOldSummary(audit[0]?.summary ?? ""),
    old[0]?.summary,
  );
  eq(
    `${label}: published at release, by the Manager user; recipients confirmed by them`,
    JSON.stringify(actual.portal),
    JSON.stringify({
      publishedAtIsSentAt: true,
      publishedByAdmin: true,
      unpublished: false,
      recipientsAddedByAdmin: true,
    }),
  );
}

async function sameAsRecordedSend() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<
    string,
    { released: Snapshot; delivered: Snapshot }
  >;
  for (const kind of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
    const expected = baseline[kind];
    if (!expected) throw new Error(`no baseline for ${kind}`);
    for (const [how, run] of [
      ["release to the default audience with email", fullRelease],
      ["legacy send", legacySend],
    ] as const) {
      section(`T-REL ${kind}: ${how} = the recorded send`);
      const out = await runCase(kind, run);
      compareWithBaseline(
        `${kind} ${how} (released)`,
        out.released,
        expected.released,
      );
      compareWithBaseline(
        `${kind} ${how} (emails delivered)`,
        out.delivered,
        expected.delivered,
      );
      // The picker's default is the rule-based audience the draft page
      // lists (deriveAudience), so the old and the new path agree.
      const candidates =
        out.draft?.candidates
          .filter((c) => kind !== "k1" || c.hasK1)
          .map((c) => c.stakeholderId)
          .sort() ?? [];
      const recipients = await db.memberReportRecipient.findMany({
        where: { companyId: out.f.c.id },
        select: { stakeholderId: true },
      });
      eq(
        `${kind} ${how}: recipients = the draft's candidates (deriveAudience)`,
        recipients
          .map((r) => r.stakeholderId)
          .sort()
          .join(","),
        candidates.join(","),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Release choices

function reportRow(f: Fixture, publicId: string) {
  return db.memberReport.findFirstOrThrow({
    where: { publicId, companyId: f.c.id },
  });
}

async function recipientsOf(f: Fixture, publicId: string) {
  const report = await reportRow(f, publicId);
  return db.memberReportRecipient.findMany({
    where: { reportId: report.id },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

function deadline(f: Fixture, key: string) {
  return db.complianceDeadline.findFirstOrThrow({
    where: { companyId: f.c.id, dedupeKey: key },
  });
}

async function portalOnly() {
  section("T-REL: release without email (portal only)");
  const f = await fixtureCompany("portal-only");
  const publicId = await quarterlyDraft(f);
  const emailsBefore = emitted.length;
  const ids = await defaultIds(f, publicId);
  eq(
    "default audience: every current Member (A, B, C)",
    ids.map((id) => f.holders.get(id)).join(","),
    "A,B,C",
  );
  const result = await f.reports.release({
    publicId,
    stakeholderIds: ids,
    email: false,
  });
  eq("nothing queued", result.queued, 0);
  eq("the result says not emailed", result.emailed, false);
  eq("deadline outcome STAYS_OPEN", result.deadlineOutcome, "STAYS_OPEN");
  eq(
    "the deadline it left open is named",
    result.deadlinesLeftOpen.join(","),
    "QUARTERLY_REPORT:2026Q3",
  );
  eq(
    "no report email was handed to the queue (only the filing job)",
    emitted
      .slice(emailsBefore)
      .map((j) => j.name)
      .join(","),
    "governance.report-file",
  );
  const report = await reportRow(f, publicId);
  eq("the report is SENT (released)", report.status, "SENT");
  check("published", report.publishedAt !== null);
  check("frozen", report.frozenHash !== null && report.frozenContent !== null);
  const rows = await recipientsOf(f, publicId);
  eq(
    "one row per selected holder",
    rows.map((r) => r.name).join(","),
    "A Preferred,B Preferred,C Common",
  );
  check(
    "never emailed: sentAt null and sendCount 0",
    rows.every((r) => r.sentAt === null && r.sendCount === 0),
  );
  eq(
    "no email-log row",
    await db.emailLog.count({
      where: { companyId: f.c.id, relatedId: report.id },
    }),
    0,
  );
  eq(
    "the quarterly deadline stays OPEN",
    (await deadline(f, "QUARTERLY_REPORT:2026Q3")).status,
    "OPEN",
  );
  const term = await db.llcTerm.findUnique({ where: { companyId: f.c.id } });
  eq(
    "the books are closed through the period end all the same",
    term?.booksClosedThrough?.toISOString().slice(0, 10),
    "2026-09-30",
  );
  const audit = await db.audit.findFirst({
    where: { companyId: f.c.id, action: "memberReport.released" },
  });
  check(
    "the audit says not emailed and that the deadline stays open",
    /not emailed \(published in the portal only\).*deadlines stay open because the report is not emailed: QUARTERLY_REPORT:2026Q3/.test(
      audit?.summary ?? "",
    ),
    audit?.summary ?? "",
  );

  section("get / list / audienceOptions after a portal-only release");
  const view = await f.reports.get({ publicId });
  check("get: publishedAt", view.report.publishedAt !== null);
  eq("get: unpublishedAt", view.report.unpublishedAt, null);
  check(
    "get: every recipient never emailed, removable, no portal account",
    view.recipients.every(
      (r) => r.emailedAt === null && r.canRemove && r.portal === "NONE",
    ),
  );
  const listed = (await f.reports.list({})).find(
    (r) => r.publicId === publicId,
  );
  eq(
    "list: 3 recipients, 0 emailed",
    [listed?.recipientCount, listed?.emailedCount].join(","),
    "3,0",
  );
  check("list: published", listed?.publishedAt != null);
  const options = await f.reports.audienceOptions({ publicId });
  check(
    "audienceOptions: recipients marked, none emailed",
    options.holders
      .filter((h) =>
        ["A", "B", "C"].includes(f.holders.get(h.stakeholderId) ?? ""),
      )
      .every((h) => h.isRecipient && h.emailedAt === null),
  );

  section("email the recipients not yet emailed (resend, seq 0)");
  const before = emitted.length;
  const resent = await f.reports.resend({ publicId });
  eq("resend queues the 3 never-emailed recipients", resent.queued, 3);
  eq(
    "each at seq 0 (claimable by the job)",
    emitted
      .slice(before)
      .map((j) => String(j.data.seq))
      .join(","),
    "0,0,0",
  );
  await deliverAll(f, publicId);
  const after = await recipientsOf(f, publicId);
  check(
    "all three emailed now",
    after.every((r) => r.sentAt !== null && r.sendCount === 1),
  );
  eq(
    "3 delivery emails logged",
    await db.emailLog.count({
      where: {
        companyId: f.c.id,
        relatedId: report.id,
        kind: "memberReport.delivery",
      },
    }),
    3,
  );
  eq(
    "the quarterly deadline is still OPEN (release is the only closer; complete it by hand)",
    (await deadline(f, "QUARTERLY_REPORT:2026Q3")).status,
    "OPEN",
  );
  const view2 = await f.reports.get({ publicId });
  check(
    "get: emailedAt set and no longer removable",
    view2.recipients.every((r) => r.emailedAt !== null && !r.canRemove),
  );
}

async function subsetAudience() {
  section("T-REL: release to a subset, with email");
  const f = await fixtureCompany("subset");
  const publicId = await quarterlyDraft(f);
  const before = emitted.length;
  const result = await f.reports.release({
    publicId,
    stakeholderIds: [f.C.id, f.A.id],
    email: true,
  });
  eq(
    "only the selected holders have rows",
    (await recipientsOf(f, publicId)).map((r) => r.name).join(","),
    "A Preferred,C Common",
  );
  eq("two emails queued", result.queued, 2);
  eq(
    "two report emails handed to the queue",
    emitted.slice(before).filter((j) => j.name === "governance.report-email")
      .length,
    2,
  );
  eq(
    "B left out: the deadline stays OPEN",
    (await deadline(f, "QUARTERLY_REPORT:2026Q3")).status,
    "OPEN",
  );
  eq("outcome STAYS_OPEN", result.deadlineOutcome, "STAYS_OPEN");
  eq(
    "warning: one current Member not selected (B)",
    JSON.stringify(
      result.warnings.map((w) => [
        w.code,
        w.stakeholderIds.map((id) => f.holders.get(id)),
      ]),
    ),
    JSON.stringify([["MEMBERS_NOT_SELECTED", ["B"]]]),
  );
  const audit = await db.audit.findFirst({
    where: { companyId: f.c.id, action: "memberReport.released" },
  });
  check(
    "the audit names the holders and why the deadline stays open",
    /to 2 recipients \(A Preferred, C Common\); emailed;.*deadlines stay open because not every holder of the default audience is selected: QUARTERLY_REPORT:2026Q3/.test(
      audit?.summary ?? "",
    ),
    audit?.summary ?? "",
  );

  section("T-REL: a notice to a Member and a Financial-Interest-only holder");
  const notice = await f.reports.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await f.reports.update({
    publicId: notice.publicId,
    title: "Notice",
    figures: {},
    commentary: [paragraph("A notice.")],
  });
  const n = await f.reports.release({
    publicId: notice.publicId,
    stakeholderIds: [f.F.id, f.A.id],
    email: false,
  });
  eq(
    "rows for A and F",
    (await recipientsOf(f, notice.publicId)).map((r) => r.name).join(","),
    "A Preferred,F Interest",
  );
  eq(
    "warnings: B and C not selected, F is not a Member, nobody has portal access",
    JSON.stringify(n.warnings.map((w) => w.code)),
    JSON.stringify([
      "MEMBERS_NOT_SELECTED",
      "NOT_MEMBERS_SELECTED",
      "RECEIVES_NOTHING",
    ]),
  );
}

async function refusedAudiences() {
  section("T-REL: refused audiences write nothing");
  const f = await fixtureCompany("refused");
  const other = await fixtureCompany("refused-other");
  const publicId = await quarterlyDraft(f);
  const k1 = await k1DraftFor(f, [f.A]);
  await db.stakeholder.update({
    where: { id: f.C.id },
    data: { noticeEmail: "   " },
  });
  const cases: [string, () => Promise<unknown>, RegExp][] = [
    [
      "a holder of another company",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: [f.A.id, other.A.id],
          email: true,
        }),
      /^A selected holder does not belong to this company\.$/,
    ],
    [
      "a prospect",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: [f.A.id, f.P.id],
          email: false,
        }),
      /A prospect cannot receive a report\. \(P Prospect\)/,
    ],
    [
      "a holder listed twice",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: [f.A.id, f.A.id],
          email: false,
        }),
      /listed more than once/,
    ],
    [
      "an invented id",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: ["__proto__"],
          email: false,
        }),
      /does not belong to this company/,
    ],
    [
      "an empty list (input check)",
      () => f.reports.release({ publicId, stakeholderIds: [], email: false }),
      /too_small|at least|>=1/i,
    ],
    [
      "email ticked and a holder without a notice address",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: [f.A.id, f.C.id],
          email: true,
        }),
      /no notice email address\. \(C Common\)/,
    ],
    [
      "inviteMissing (package P4b) is not accepted yet",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: [f.A.id],
          email: false,
          inviteMissing: true as unknown as false,
        }),
      /false|invalid/i,
    ],
    [
      "a K-1 report recipient without a K-1 attached",
      () =>
        f.reports.release({
          publicId: k1,
          stakeholderIds: [f.A.id, f.B.id],
          email: false,
        }),
      /no K-1 attached to this report\. \(B Preferred\)/,
    ],
  ];
  for (const [label, run, pattern] of cases) {
    const error = await errorOf(run);
    check(
      `refused: ${label}`,
      error !== null &&
        pattern.test(error.message) &&
        error.code === "BAD_REQUEST",
      error ? `${error.code}: ${error.message}` : "it succeeded",
    );
  }
  for (const id of [publicId, k1]) {
    const r = await reportRow(f, id);
    eq(`${r.type}: still a DRAFT`, r.status, "DRAFT");
    eq(`${r.type}: not published`, r.publishedAt, null);
    eq(
      `${r.type}: no recipient row`,
      await db.memberReportRecipient.count({ where: { reportId: r.id } }),
      0,
    );
  }
  const term = await db.llcTerm.findUnique({ where: { companyId: f.c.id } });
  eq("the books were not closed", term?.booksClosedThrough ?? null, null);
  eq(
    "the deadline is OPEN",
    (await deadline(f, "QUARTERLY_REPORT:2026Q3")).status,
    "OPEN",
  );
  eq(
    "no release audit",
    await db.audit.count({
      where: { companyId: f.c.id, action: "memberReport.released" },
    }),
    0,
  );
  // The same holder without a notice address is fine without email.
  const ok = await errorOf(() =>
    f.reports.release({
      publicId,
      stakeholderIds: [f.A.id, f.C.id],
      email: false,
    }),
  );
  check(
    "without email a holder without a notice address is accepted",
    ok === null,
    ok?.message ?? "",
  );
  eq(
    "its row has no address (it cannot be emailed until one is set)",
    (await recipientsOf(f, publicId)).find((r) => r.stakeholderId === f.C.id)
      ?.email,
    "",
  );
}

/** A FY2026 K-1 report with K-1s for the given holders only (no deadline link). */
async function k1DraftFor(f: Fixture, holders: { id: string }[]) {
  const { publicId } = await f.reports.create({
    type: "TAX_K1",
    fiscalYear: 2026,
  });
  for (const h of holders) {
    const bucket = await testBucket(`${f.c.id}/zz-k1b/${h.id}.pdf`);
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

async function k1Privacy() {
  section("T-REL: K-1 privacy with a partial audience");
  const f = await fixtureCompany("k1-partial");
  await inTx((tx) => syncComplianceDeadlines(tx, f.c.id, new Date()));
  const publicId = await k1DraftFor(f, [f.A, f.B, f.C, f.F]);
  const options = await f.reports.audienceOptions({ publicId });
  eq(
    "TAX_K1 default: the holders with a K-1 (A, B, C, F; never the prospect)",
    (
      options.presets
        .find((p) => p.key === options.defaultPreset)
        ?.stakeholderIds.map((id) => f.holders.get(id))
        .sort() ?? []
    ).join(","),
    "A,B,C,F",
  );
  check(
    "audienceOptions never lists the prospect",
    !options.holders.some((h) => h.stakeholderId === f.P.id),
  );
  const result = await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.F.id],
    email: true,
  });
  eq("K-1 with email: coverage rule", result.deadlineOutcome, "K1_COVERAGE");
  const rows = await recipientsOf(f, publicId);
  eq(
    "rows for A and F only",
    rows.map((r) => r.name).join(","),
    "A Preferred,F Interest",
  );
  const view = createCallerFactory(memberReportViewRouter)({
    db,
    session: null,
    requestIp: "127.0.0.1",
    userAgent: "release-integration",
    headers: new Headers(),
  } as never);
  for (const r of rows) {
    const token = await signReportToken(r);
    const page = await view.view({ token });
    const names =
      page.state === "OK" ? page.attachments.map((a) => a.name) : [];
    eq(
      `${r.name} sees only its own K-1`,
      names.join(","),
      `K-1 ${f.holders.get(r.stakeholderId)}.pdf`,
    );
  }
  await deliverAll(f, publicId);
  eq(
    "A and F emailed, B and C not: the K-1 deadlines stay OPEN",
    (
      await db.complianceDeadline.findMany({
        where: {
          companyId: f.c.id,
          ruleKey: { in: ["K1_TARGET", "K1_FINAL"] },
        },
        orderBy: { dedupeKey: "asc" },
      })
    )
      .map((d) => d.status)
      .join(","),
    "OPEN,OPEN",
  );

  section("T-REL: a portal-only K-1 release closes no K-1 deadline");
  const g = await fixtureCompany("k1-portal");
  await inTx((tx) => syncComplianceDeadlines(tx, g.c.id, new Date()));
  const k1 = await k1DraftFor(g, [g.A, g.B, g.C, g.F]);
  const r2 = await g.reports.release({
    publicId: k1,
    stakeholderIds: [g.A.id, g.B.id, g.C.id, g.F.id],
    email: false,
  });
  eq("outcome STAYS_OPEN", r2.deadlineOutcome, "STAYS_OPEN");
  eq(
    "both K-1 deadlines named as left open",
    r2.deadlinesLeftOpen.join(","),
    "K1_FINAL:2026,K1_TARGET:2026",
  );
  const cov = await inTx((tx) => loadK1Coverage(tx, g.c.id, 2026));
  eq("coverage: nobody delivered (not emailed)", cov.complete, false);
}

async function publishState() {
  section("T-REL: unpublish and publish again");
  const f = await fixtureCompany("publish");
  const publicId = await quarterlyDraft(f);
  await expectRefused(
    "unpublish of a DRAFT is refused",
    () => f.reports.unpublish({ publicId }),
    /Only a released report/,
    "BAD_REQUEST",
  );
  await f.reports.release({
    publicId,
    stakeholderIds: await defaultIds(f, publicId),
    email: false,
  });
  const before = await reportRow(f, publicId);
  const rowsBefore = JSON.stringify(
    (await recipientsOf(f, publicId)).map((r) => [r.id, r.updatedAt]),
  );
  const termBefore = await db.llcTerm.findUnique({
    where: { companyId: f.c.id },
  });
  eq("unpublish", (await f.reports.unpublish({ publicId })).changed, true);
  const hidden = await reportRow(f, publicId);
  check("unpublishedAt set", hidden.unpublishedAt !== null);
  eq("by the Manager user", hidden.unpublishedById, f.memberId);
  eq(
    "a second unpublish changes nothing",
    (await f.reports.unpublish({ publicId })).changed,
    false,
  );
  eq("publish again", (await f.reports.publish({ publicId })).changed, true);
  const again = await reportRow(f, publicId);
  eq("unpublishedAt cleared", again.unpublishedAt, null);
  eq(
    "publishedAt unchanged",
    again.publishedAt?.toISOString(),
    before.publishedAt?.toISOString(),
  );
  eq(
    "a second publish changes nothing",
    (await f.reports.publish({ publicId })).changed,
    false,
  );
  eq("frozen hash unchanged", again.frozenHash, before.frozenHash);
  eq("status unchanged", again.status, "SENT");
  eq(
    "recipient rows untouched",
    JSON.stringify(
      (await recipientsOf(f, publicId)).map((r) => [r.id, r.updatedAt]),
    ),
    rowsBefore,
  );
  const termAfter = await db.llcTerm.findUnique({
    where: { companyId: f.c.id },
  });
  eq(
    "books untouched",
    termAfter?.booksClosedThrough?.toISOString(),
    termBefore?.booksClosedThrough?.toISOString(),
  );
  eq(
    "audit: unpublished once, published once",
    (
      await db.audit.findMany({
        where: {
          companyId: f.c.id,
          action: {
            in: ["memberReport.unpublished", "memberReport.published"],
          },
        },
        orderBy: { occurredAt: "asc" },
      })
    )
      .map((a) => a.action)
      .join(","),
    "memberReport.unpublished,memberReport.published",
  );
}

/** A report "sent before the portal": SENT, `publishedAt` null, one recipient. */
async function legacyReport(f: Fixture) {
  const now = new Date();
  const report = await db.memberReport.create({
    data: {
      publicId: `zz-release-${Math.random().toString(36).slice(2, 12)}`,
      companyId: f.c.id,
      type: "NOTICE",
      status: "SENT",
      noticeKind: "GENERAL",
      title: "Old notice",
      commentary: [],
      figures: {},
      frozenContent: { title: "Old notice", doc: [] },
      frozenHash: "x",
      sentAt: now,
      authorId: f.memberId,
    },
  });
  const recipient = await db.memberReportRecipient.create({
    data: {
      reportId: report.id,
      companyId: f.c.id,
      stakeholderId: f.A.id,
      name: f.A.name,
      email: f.A.email,
      tokenExpiresAt: new Date(now.getTime() + 86_400_000),
      sentAt: now,
      sendCount: 1,
    },
  });
  return { report, recipient };
}

async function legacyReports() {
  section("Reports sent before the portal keep working");
  const f = await fixtureCompany("legacy");
  const { report, recipient } = await legacyReport(f);
  const view = await f.reports.get({ publicId: report.publicId });
  eq("get: never published", view.report.publishedAt, null);
  eq(
    "get: the recipient's emailedAt is its email",
    view.recipients[0]?.emailedAt?.toISOString(),
    recipient.sentAt?.toISOString(),
  );
  eq(
    "get: addedById null (before the portal)",
    view.recipients[0]?.addedById,
    null,
  );
  const resent = await f.reports.resend({ publicId: report.publicId });
  eq("resend still queues its recipient", resent.queued, 1);
  const replaced = await errorOf(() =>
    f.reports.replaceLink({
      publicId: report.publicId,
      recipientId: recipient.id,
    }),
  );
  check("replaceLink still works", replaced === null, replaced?.message ?? "");
  const page = await createCallerFactory(memberReportViewRouter)({
    db,
    session: null,
    requestIp: "127.0.0.1",
    userAgent: "release-integration",
    headers: new Headers(),
  } as never).view({
    token: await signReportToken(
      await db.memberReportRecipient.findUniqueOrThrow({
        where: { id: recipient.id },
      }),
    ),
  });
  eq("its emailed link still opens the report", page.state, "OK");
  await expectRefused(
    "unpublish is refused: it was never in the portal",
    () => f.reports.unpublish({ publicId: report.publicId }),
    /sent before the investor portal/,
    "BAD_REQUEST",
  );
  eq(
    "publish puts it in the portal",
    (await f.reports.publish({ publicId: report.publicId })).changed,
    true,
  );
  const after = await reportRow(f, report.publicId);
  check("publishedAt set", after.publishedAt !== null);
  eq(
    "sentAt unchanged",
    after.sentAt?.toISOString(),
    report.sentAt?.toISOString(),
  );
  eq(
    "recipients unchanged",
    await db.memberReportRecipient.count({ where: { reportId: report.id } }),
    1,
  );
}

async function concurrentRelease() {
  section("T-REL: two concurrent releases of one draft");
  const f = await fixtureCompany("race");
  const publicId = await quarterlyDraft(f);
  const ids = await defaultIds(f, publicId);
  const outcomes = await Promise.all([
    errorOf(() =>
      f.reports.release({ publicId, stakeholderIds: ids, email: true }),
    ),
    errorOf(() =>
      f.reports.release({ publicId, stakeholderIds: ids, email: false }),
    ),
    errorOf(() => f.reports.send({ publicId })),
  ]);
  eq("exactly one succeeds", outcomes.filter((o) => o === null).length, 1);
  check(
    "the others are refused as already released / sent",
    outcomes
      .filter((o) => o !== null)
      .every((o) => /already been (released|sent)/.test(o?.message ?? "")),
    JSON.stringify(outcomes),
  );
  eq("one row per holder", (await recipientsOf(f, publicId)).length, 3);
  eq(
    "one release audit",
    await db.audit.count({
      where: { companyId: f.c.id, action: "memberReport.released" },
    }),
    1,
  );
}

async function mailGuard() {
  section("T-REL: production with the mail catcher");
  const f = await fixtureCompany("mail-guard");
  const publicId = await quarterlyDraft(f);
  const ids = await defaultIds(f, publicId);
  const penv = process.env as Record<string, string | undefined>;
  const previous = penv.NODE_ENV;
  penv.NODE_ENV = "production";
  try {
    await expectRefused(
      "release with email is refused",
      () => f.reports.release({ publicId, stakeholderIds: ids, email: true }),
      /closes the books .* local mail catcher/,
      "BAD_REQUEST",
    );
    await expectRefused(
      "the legacy send is refused",
      () => f.reports.send({ publicId }),
      /closes the books .* local mail catcher/,
      "BAD_REQUEST",
    );
    const r = await reportRow(f, publicId);
    eq("nothing was written: still a DRAFT", r.status, "DRAFT");
    eq(
      "no recipient row",
      await db.memberReportRecipient.count({ where: { reportId: r.id } }),
      0,
    );
    const ok = await errorOf(() =>
      f.reports.release({ publicId, stakeholderIds: ids, email: false }),
    );
    check("release without email is accepted", ok === null, ok?.message ?? "");
  } finally {
    penv.NODE_ENV = previous;
  }
  const r = await reportRow(f, publicId);
  eq(
    "released and published",
    [r.status, r.publishedAt !== null].join(","),
    "SENT,true",
  );
}

async function portalColumns() {
  section("get: portal state, portal views and canRemove");
  const f = await fixtureCompany("portal-columns");
  const publicId = await quarterlyDraft(f);
  await f.reports.release({
    publicId,
    stakeholderIds: await defaultIds(f, publicId),
    email: false,
  });
  const report = await reportRow(f, publicId);
  const users: string[] = [];
  try {
    const invited = await db.portalUser.create({
      data: { email: `release.invited.${f.c.id}@example.com` },
    });
    const active = await db.portalUser.create({
      data: {
        email: `release.active.${f.c.id}@example.com`,
        passwordHash:
          "$2b$12$notarealhashnotarealhashnotarealhashnotarealhashnot",
      },
    });
    const disabled = await db.portalUser.create({
      data: {
        email: `release.disabled.${f.c.id}@example.com`,
        passwordHash:
          "$2b$12$notarealhashnotarealhashnotarealhashnotarealhashnot",
      },
    });
    users.push(invited.id, active.id, disabled.id);
    const access = (
      portalUserId: string,
      stakeholderId: string,
      status: "ACTIVE" | "DISABLED" = "ACTIVE",
    ) =>
      db.portalAccess.create({
        data: {
          publicId: `zz-release-${Math.random().toString(36).slice(2, 12)}`,
          portalUserId,
          companyId: f.c.id,
          stakeholderId,
          status,
          invitedById: f.memberId,
        },
      });
    await access(invited.id, f.A.id);
    const bAccess = await access(active.id, f.B.id);
    await access(disabled.id, f.C.id, "DISABLED");
    await db.portalAccessLog.create({
      data: {
        companyId: f.c.id,
        portalUserId: active.id,
        portalAccessId: bAccess.id,
        stakeholderId: f.B.id,
        event: "REPORT_VIEWED",
        targetType: "memberReport",
        targetId: report.id,
        ip: "127.0.0.1",
        userAgent: "release-integration",
      },
    });
    const view = await f.reports.get({ publicId });
    const byName = new Map(view.recipients.map((r) => [r.name, r]));
    eq(
      "portal: A invited, B active, C (disabled access) none",
      ["A Preferred", "B Preferred", "C Common"]
        .map((n) => byName.get(n)?.portal)
        .join(","),
      "INVITED,ACTIVE,NONE",
    );
    check(
      "B's portal view is reported",
      byName.get("B Preferred")?.portalFirstViewedAt != null,
    );
    eq(
      "canRemove: A and C yes, B no (opened in the portal)",
      ["A Preferred", "B Preferred", "C Common"]
        .map((n) => String(byName.get(n)?.canRemove))
        .join(","),
      "true,false,true",
    );
    const options = await f.reports.audienceOptions({ publicId });
    eq(
      "audienceOptions: the same portal states",
      [f.A.id, f.B.id, f.C.id]
        .map(
          (id) => options.holders.find((h) => h.stakeholderId === id)?.portal,
        )
        .join(","),
      "INVITED,ACTIVE,NONE",
    );
  } finally {
    // PortalUser has no companyId column: the harness cleanup cannot see it.
    await db.portalAccess.deleteMany({ where: { companyId: f.c.id } });
    await db.portalUser.deleteMany({ where: { id: { in: users } } });
  }
}

await runScenarios(
  RECORD
    ? [
        ["record baseline", record],
        ["K-1 files", deleteBuckets],
      ]
    : [
        ["same as the recorded send", sameAsRecordedSend],
        ["portal only", portalOnly],
        ["subset", subsetAudience],
        ["refused audiences", refusedAudiences],
        ["K-1 privacy", k1Privacy],
        ["publish state", publishState],
        ["legacy reports", legacyReports],
        ["concurrent release", concurrentRelease],
        ["mail guard", mailGuard],
        ["portal columns", portalColumns],
        ["K-1 files", deleteBuckets],
      ],
);
