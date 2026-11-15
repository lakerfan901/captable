/**
 * Release of member reports (04-investor-portal.md P17–P27, packages P4a
 * and P4b), against the local database. Not part of `vitest run`. Run from the
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
 * `release` to every current Member with email field by field with that
 * record. (`send` itself was removed in P4c.)
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
import {
  type PortalAccountEmailData,
  portalAccountEmailJob,
} from "@/server/portal/account-email";
import { createCallerFactory } from "@/trpc/api/trpc";
import { governanceRouter } from "@/trpc/routers/governance-router/router";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { memberReportViewRouter } from "@/trpc/routers/member-report-view-router/router";
import { portalAdminRouter } from "@/trpc/routers/portal-admin-router/router";
import { unitTransferRouter } from "@/trpc/routers/unit-transfer-router/router";
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

/**
 * How the baseline was recorded (RELEASE_BASELINE=record) on the commit
 * before P4a. `memberReport.send` no longer exists (removed in P4c), so a
 * re-recording runs on that commit; the default run compares `release`.
 */
const legacySend: Releaser = (f, publicId) =>
  (
    f.reports as unknown as {
      send: (input: { publicId: string }) => Promise<unknown>;
    }
  ).send({ publicId });

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
    // The second pass of the former legacy `send` entry point is gone with
    // it (P4c); `release` to the default audience is compared alone.
    for (const [how, run] of [
      ["release to the default audience with email", fullRelease],
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
    errorOf(() =>
      f.reports.release({ publicId, stakeholderIds: ids, email: true }),
    ),
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
    // P3's rule (describeAccess): set up = a password set at or after THIS
    // access was invited.
    await db.portalUser.update({
      where: { id: active.id },
      data: { passwordSetAt: new Date(Date.now() + 1000) },
    });
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

// ---------------------------------------------------------------------------
// Package P4b: after release (add / remove recipients, email rounds,
// invitations, unpublished refusals, the portal state rule)

// Account emails (invitations) are captured, as the report emails.
const accountEmails: PortalAccountEmailData[] = [];
Object.assign(portalAccountEmailJob, {
  emit: (data: PortalAccountEmailData) => {
    accountEmails.push(data);
    return Promise.resolve(null);
  },
});

/** Portal users and team users created by the P4b scenarios (no companyId). */
const portalEmails = new Set<string>();
const customUserIds: string[] = [];

const uniqueAddress = (label: string) =>
  `zz-release-p4b.${label}.${Math.random().toString(36).slice(2, 10)}@example.com`;

async function cleanupP4b() {
  section("cleanup: portal users and custom team users of the P4b scenarios");
  const users = await db.portalUser.findMany({
    where: { email: { in: [...portalEmails] } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await db.portalAccountToken.deleteMany({
    where: { portalUserId: { in: ids } },
  });
  await db.portalSession.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalAccessLog.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalAccess.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalUser.deleteMany({ where: { id: { in: ids } } });
  await db.member.deleteMany({ where: { userId: { in: customUserIds } } });
  await db.user.deleteMany({ where: { id: { in: customUserIds } } });
  eq(
    "no portal user or custom team user of this run is left",
    (await db.portalUser.count({ where: { id: { in: ids } } })) +
      (await db.user.count({ where: { id: { in: customUserIds } } })),
    0,
  );
}

/** A team member of `f`'s company with a custom role holding exactly `permissions`. */
async function customCaller(
  f: Fixture,
  permissions: { subject: string; actions: string[] }[],
) {
  const user = await db.user.create({
    data: { name: "Custom", email: uniqueAddress("team") },
  });
  customUserIds.push(user.id);
  const role = await db.customRole.create({
    data: { companyId: f.c.id, name: "Custom", permissions },
  });
  const member = await db.member.create({
    data: {
      companyId: f.c.id,
      userId: user.id,
      status: "ACTIVE",
      isOnboarded: true,
      role: "CUSTOM",
      customRoleId: role.id,
    },
  });
  return createCallerFactory(memberReportRouter)({
    db,
    session: {
      user: {
        id: user.id,
        name: "Custom",
        email: user.email,
        companyId: f.c.id,
        memberId: member.id,
        companyPublicId: f.c.name,
        isOnboarded: true,
      },
      expires: "2099-01-01T00:00:00.000Z",
    },
    requestIp: "127.0.0.1",
    userAgent: "release-integration",
    headers: new Headers(),
  } as never);
}

/** A portal user (tracked for cleanup) with one access to `stakeholderId`. */
async function portalAccessFor(
  f: Fixture,
  email: string,
  stakeholderId: string,
  opts: {
    status?: "ACTIVE" | "DISABLED";
    passwordSetAt?: Date | null;
    invitedAt?: Date;
    lastSeenAt?: Date | null;
  } = {},
) {
  portalEmails.add(email);
  const user = await db.portalUser.upsert({
    where: { email },
    create: {
      email,
      passwordHash:
        opts.passwordSetAt != null
          ? "$2b$12$notarealhashnotarealhashnotarealhashnotarealhashnot"
          : null,
      passwordSetAt: opts.passwordSetAt ?? null,
    },
    update: {},
  });
  return db.portalAccess.create({
    data: {
      publicId: `zz-release-${Math.random().toString(36).slice(2, 12)}`,
      portalUserId: user.id,
      companyId: f.c.id,
      stakeholderId,
      status: opts.status ?? "ACTIVE",
      invitedById: f.memberId,
      invitedAt: opts.invitedAt ?? new Date(),
      lastSeenAt: opts.lastSeenAt ?? null,
    },
  });
}

const emailJobsSince = (from: number) =>
  emitted.slice(from).filter((j) => j.name === "governance.report-email");

function failedEmailLogs(f: Fixture) {
  return db.emailLog.count({ where: { companyId: f.c.id, status: "FAILED" } });
}

/** Finding 1 (resend re-added left-out K-1 holders) and finding 2 (blank addresses). */
async function resendNeverAdds() {
  section(
    "P4b finding 1: resend never creates recipients (partial K-1 release)",
  );
  const f = await fixtureCompany("p4b-k1");
  await inTx((tx) => syncComplianceDeadlines(tx, f.c.id, new Date()));
  const publicId = await k1DraftFor(f, [f.A, f.B, f.C, f.F]);
  // C has no notice address at all.
  await db.stakeholder.update({
    where: { id: f.C.id },
    data: { email: "", noticeEmail: null },
  });
  await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.F.id],
    email: true,
  });
  await deliverAll(f, publicId);
  const before = emitted.length;
  const all = await f.reports.resend({ publicId });
  eq(
    "resend to all: still only A and F (B and C were left out by the Manager user)",
    (await recipientsOf(f, publicId)).map((r) => r.name).join(","),
    "A Preferred,F Interest",
  );
  eq(
    "resend to all: 2 queued, none skipped",
    [all.queued, all.skipped.length].join(","),
    "2,0",
  );
  eq("2 report emails handed to the queue", emailJobsSince(before).length, 2);
  check(
    "C without any address does not make the resend fail",
    (await errorOf(() => f.reports.resend({ publicId }))) === null,
  );
  const notEmailed = await f.reports.resend({ publicId, scope: "NOT_EMAILED" });
  eq("NOT_EMAILED: A and F were emailed, nothing queued", notEmailed.queued, 0);
  const audit = await db.audit.findFirst({
    where: { companyId: f.c.id, action: "memberReport.resent" },
    orderBy: { occurredAt: "desc" },
  });
  check(
    "the resend audit names no new K-1 recipient",
    !/new K-1 recipients/.test(audit?.summary ?? ""),
    audit?.summary ?? "",
  );

  section("P4b: addRecipients is how a late or left-out K-1 holder joins");
  const options = await f.reports.audienceOptions({ publicId });
  eq(
    "audienceOptions: B and C have a K-1 and are not recipients",
    options.holders
      .filter((h) => h.hasK1 && !h.isRecipient)
      .map((h) => f.holders.get(h.stakeholderId))
      .sort()
      .join(","),
    "B,C",
  );
  await expectRefused(
    "adding C with email is refused: no notice address",
    () =>
      f.reports.addRecipients({
        publicId,
        stakeholderIds: [f.C.id],
        email: true,
      }),
    /no notice email address\. \(C Common\)/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "adding the prospect is refused (and has no K-1)",
    () =>
      f.reports.addRecipients({
        publicId,
        stakeholderIds: [f.P.id],
        email: false,
      }),
    /prospect cannot receive a report.*no K-1 attached/,
    "BAD_REQUEST",
  );
  eq(
    "nothing was added by the refusals",
    (await recipientsOf(f, publicId)).length,
    2,
  );
  const b0 = emitted.length;
  const addB = await f.reports.addRecipients({
    publicId,
    stakeholderIds: [f.B.id],
    email: true,
  });
  eq(
    "B added with email: one row, one email queued",
    [addB.added.length, addB.queued].join(","),
    "1,1",
  );
  eq(
    "the job is for B's new row at seq 0",
    emailJobsSince(b0)
      .map(
        (j) =>
          `${j.data.recipientId === addB.added[0]?.recipientId}:${String(j.data.seq)}`,
      )
      .join(","),
    "true:0",
  );
  const bRow = await db.memberReportRecipient.findUniqueOrThrow({
    where: { id: addB.added[0]?.recipientId ?? "" },
  });
  const bPage = await createCallerFactory(memberReportViewRouter)({
    db,
    session: null,
    requestIp: "127.0.0.1",
    userAgent: "release-integration",
    headers: new Headers(),
  } as never).view({ token: await signReportToken(bRow) });
  eq(
    "an added K-1 holder sees only its own K-1",
    bPage.state === "OK" ? bPage.attachments.map((x) => x.name).join(",") : "",
    "K-1 B.pdf",
  );
  const addC = await f.reports.addRecipients({
    publicId,
    stakeholderIds: [f.C.id],
    email: false,
  });
  eq(
    "C added without email: one row, nothing queued",
    [addC.added.length, addC.queued].join(","),
    "1,0",
  );
  const cRow = (await recipientsOf(f, publicId)).find(
    (r) => r.stakeholderId === f.C.id,
  );
  eq(
    "C's row has no address and was added by the Manager user",
    [cRow?.email, cRow?.addedById === f.memberId].join(","),
    ",true",
  );
  eq(
    "audit memberReport.recipients-added twice",
    await db.audit.count({
      where: { companyId: f.c.id, action: "memberReport.recipients-added" },
    }),
    2,
  );
  await deliverAll(f, publicId);

  section("P4b finding 2: a recipient without an address is never queued");
  const s0 = emitted.length;
  const again = await f.reports.resend({ publicId });
  eq("resend to all: A, B, F queued; C skipped", again.queued, 3);
  eq(
    "C skipped with the reason",
    JSON.stringify(again.skipped.map((s) => [s.name, s.reason])),
    JSON.stringify([["C Common", "NO_ADDRESS"]]),
  );
  eq(
    "exactly 3 report emails handed to the queue",
    emailJobsSince(s0).length,
    3,
  );
  const ne = await f.reports.resend({ publicId, scope: "NOT_EMAILED" });
  eq(
    "NOT_EMAILED: only C is not emailed, and it is skipped",
    [ne.queued, ne.skipped.map((s) => s.name).join()].join(","),
    "0,C Common",
  );
  await expectRefused(
    "resend to C alone is refused, naming C",
    () => f.reports.resend({ publicId, recipientId: cRow?.id ?? "" }),
    /^C Common has no email address\./,
    "BAD_REQUEST",
  );
  await expectRefused(
    "replaceLink for C without an address is refused, naming C",
    () => f.reports.replaceLink({ publicId, recipientId: cRow?.id ?? "" }),
    /^C Common has no email address\. Enter one/,
    "BAD_REQUEST",
  );
  const r0 = emitted.length;
  const replaced = await errorOf(() =>
    f.reports.replaceLink({
      publicId,
      recipientId: cRow?.id ?? "",
      email: "c.new@example.com",
    }),
  );
  check(
    "replaceLink for C with an address works",
    replaced === null,
    replaced?.message ?? "",
  );
  eq(
    "one report email queued, to C's row; no address-changed notice (there was no address)",
    emailJobsSince(r0)
      .map(
        (j) =>
          `${j.data.recipientId === cRow?.id}:${String(j.data.kind ?? "DELIVERY")}`,
      )
      .join(","),
    "true:DELIVERY",
  );
  const replaceAudit = await db.audit.findFirst({
    where: { companyId: f.c.id, action: "memberReport.resent" },
    orderBy: { occurredAt: "desc" },
  });
  check(
    "the audit says the address was set",
    /set the email to c\.new@example\.com \(there was none\)/.test(
      replaceAudit?.summary ?? "",
    ),
    replaceAudit?.summary ?? "",
  );
  const c1 = await db.memberReportRecipient.findUniqueOrThrow({
    where: { id: cRow?.id ?? "" },
  });
  await runReportJob(c1.id, c1.sendCount);
  check(
    "C is emailed now",
    (await db.memberReportRecipient.findUniqueOrThrow({ where: { id: c1.id } }))
      .sentAt !== null,
  );
  eq("no FAILED email-log row was ever written", await failedEmailLogs(f), 0);

  section(
    "P4b: the K-1 deadlines close by themselves once every holder of the year is emailed",
  );
  eq(
    "A, B, C, F emailed (P is a prospect): both K-1 deadlines DONE",
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
    "DONE,DONE",
  );

  section(
    "P4b: a job queued for a blank address sends nothing and does not fail",
  );
  const g = await fixtureCompany("p4b-blank-job");
  const q = await quarterlyDraft(g);
  await db.stakeholder.update({
    where: { id: g.C.id },
    data: { email: "", noticeEmail: null },
  });
  await g.reports.release({
    publicId: q,
    stakeholderIds: [g.A.id, g.C.id],
    email: false,
  });
  const blank = (await recipientsOf(g, q)).find(
    (r) => r.stakeholderId === g.C.id,
  );
  const jobErr = await errorOf(() => runReportJob(blank?.id ?? "", 0));
  check(
    "the job returns without an error",
    jobErr === null,
    jobErr?.message ?? "",
  );
  const blankAfter = await db.memberReportRecipient.findUniqueOrThrow({
    where: { id: blank?.id ?? "" },
  });
  eq(
    "no claim taken, no email log",
    [
      blankAfter.sendCount,
      await db.emailLog.count({ where: { companyId: g.c.id } }),
    ].join(","),
    "0,0",
  );
}

/** addRecipients on a quarterly report: deadlines, duplicates, refusals, concurrency. */
async function addRecipientsScenario() {
  section("P4b: addRecipients on a quarterly report");
  const f = await fixtureCompany("p4b-add");
  const publicId = await quarterlyDraft(f);
  await expectRefused(
    "addRecipients on a DRAFT is refused",
    () =>
      f.reports.addRecipients({
        publicId,
        stakeholderIds: [f.A.id],
        email: false,
      }),
    /only to a released report/,
    "BAD_REQUEST",
  );
  await f.reports.release({ publicId, stakeholderIds: [f.A.id], email: false });
  const other = await fixtureCompany("p4b-add-other");
  await expectRefused(
    "a holder of another company is refused",
    () =>
      f.reports.addRecipients({
        publicId,
        stakeholderIds: [other.B.id],
        email: false,
      }),
    /does not belong to this company/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "a list naming a holder twice is refused",
    () =>
      f.reports.addRecipients({
        publicId,
        stakeholderIds: [f.B.id, f.B.id],
        email: false,
      }),
    /listed more than once/,
    "BAD_REQUEST",
  );
  eq(
    "only A is a recipient",
    (await recipientsOf(f, publicId)).map((r) => r.name).join(","),
    "A Preferred",
  );
  const b0 = emitted.length;
  const added = await f.reports.addRecipients({
    publicId,
    stakeholderIds: [f.C.id, f.B.id, f.A.id],
    email: true,
  });
  eq(
    "B and C added (register order), A already a recipient",
    [
      added.added.map((a) => a.name).join("+"),
      added.alreadyRecipients.map((id) => f.holders.get(id)).join("+"),
    ].join(","),
    "B Preferred+C Common,A",
  );
  eq(
    "two emails queued, A is not re-emailed",
    [added.queued, emailJobsSince(b0).length].join(","),
    "2,2",
  );
  eq(
    "no warning left: every current Member is a recipient",
    added.warnings.length,
    0,
  );
  await deliverAll(f, publicId);
  eq(
    "every current Member is now a recipient and B, C emailed: the quarterly deadline stays OPEN (completed by hand only)",
    (await deadline(f, "QUARTERLY_REPORT:2026Q3")).status,
    "OPEN",
  );
  const audit = await db.audit.findFirst({
    where: { companyId: f.c.id, action: "memberReport.recipients-added" },
  });
  check(
    "the audit names the holders, says emailed and that no deadline is closed",
    /added 2 recipients to the report "Q3 2026 report to Members" \(B Preferred, C Common\); emailed; no deadline is closed by an addition/.test(
      audit?.summary ?? "",
    ),
    audit?.summary ?? "",
  );

  section("P4b: an addition that adds nothing writes nothing");
  const a0 = await db.audit.count({ where: { companyId: f.c.id } });
  const nothing = await f.reports.addRecipients({
    publicId,
    stakeholderIds: [f.B.id],
    email: true,
  });
  eq(
    "nothing added, nothing queued",
    [nothing.added.length, nothing.queued].join(","),
    "0,0",
  );
  eq(
    "no audit row",
    await db.audit.count({ where: { companyId: f.c.id } }),
    a0,
  );

  section("P4b: two concurrent additions of the same holder add it once");
  const c0 = emitted.length;
  const both = await Promise.all([
    f.reports.addRecipients({
      publicId,
      stakeholderIds: [f.F.id],
      email: true,
    }),
    f.reports.addRecipients({
      publicId,
      stakeholderIds: [f.F.id],
      email: true,
    }),
  ]);
  eq(
    "one row for F",
    (await recipientsOf(f, publicId)).filter((r) => r.stakeholderId === f.F.id)
      .length,
    1,
  );
  eq(
    "added once in total",
    both.reduce((n, r) => n + r.added.length, 0),
    1,
  );
  eq(
    "queued once in total",
    [both.reduce((n, r) => n + r.queued, 0), emailJobsSince(c0).length].join(
      ",",
    ),
    "1,1",
  );
  eq(
    "warning on the call that added F: not a Member",
    both.flatMap((r) => r.warnings.map((w) => w.code)).join(","),
    "NOT_MEMBERS_SELECTED",
  );
}

/** removeRecipient: the rule, history kept, and the race with the email job. */
async function removeRecipientScenario() {
  section("P4b: removeRecipient");
  const f = await fixtureCompany("p4b-remove");
  const publicId = await quarterlyDraft(f);
  await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.B.id, f.C.id, f.F.id],
    email: false,
  });
  const report = await reportRow(f, publicId);
  const rowOf = async (id: string) => {
    const r = (await recipientsOf(f, publicId)).find(
      (x) => x.stakeholderId === id,
    );
    if (!r) throw new Error(`no row for ${id}`);
    return r;
  };
  const a = await rowOf(f.A.id);
  const view = await f.reports.get({ publicId });
  check(
    "get: A can be removed",
    view.recipients.find((r) => r.id === a.id)?.canRemove === true,
  );
  const removed = await f.reports.removeRecipient({
    publicId,
    recipientId: a.id,
  });
  eq("A removed", removed.name, "A Preferred");
  eq(
    "A has no row any more",
    (await recipientsOf(f, publicId)).some((r) => r.stakeholderId === f.A.id),
    false,
  );
  const audit = await db.audit.findFirst({
    where: { companyId: f.c.id, action: "memberReport.recipient-removed" },
  });
  check(
    "the audit keeps name, address and that it was never emailed or opened",
    new RegExp(
      `removed A Preferred \\(${f.A.email.replace(/\./g, "\\.")}\\) from the recipients .*never emailed and never opened; added .* by a Manager user`,
    ).test(audit?.summary ?? ""),
    audit?.summary ?? "",
  );
  await expectRefused(
    "removing it again: not found",
    () => f.reports.removeRecipient({ publicId, recipientId: a.id }),
    /Recipient not found/,
    "NOT_FOUND",
  );

  // B is emailed.
  await f.reports.resend({ publicId, recipientId: (await rowOf(f.B.id)).id });
  await runReportJob((await rowOf(f.B.id)).id, 0);
  await expectRefused(
    "an emailed recipient cannot be removed",
    () =>
      rowOf(f.B.id).then((b) =>
        f.reports.removeRecipient({ publicId, recipientId: b.id }),
      ),
    /has been emailed/,
    "BAD_REQUEST",
  );
  // C opened the emailed link.
  const c = await rowOf(f.C.id);
  await db.memberReportRecipient.update({
    where: { id: c.id },
    data: { firstViewedAt: new Date(), viewCount: 1 },
  });
  await expectRefused(
    "a recipient that opened the emailed link cannot be removed",
    () => f.reports.removeRecipient({ publicId, recipientId: c.id }),
    /opened the report through the emailed link/,
    "BAD_REQUEST",
  );
  // F opened it in the portal.
  const access = await portalAccessFor(f, uniqueAddress("f"), f.F.id, {
    passwordSetAt: new Date(),
  });
  await db.portalAccessLog.create({
    data: {
      companyId: f.c.id,
      portalUserId: access.portalUserId,
      portalAccessId: access.id,
      stakeholderId: f.F.id,
      event: "REPORT_VIEWED",
      targetType: "memberReport",
      targetId: report.id,
      ip: "127.0.0.1",
      userAgent: "release-integration",
    },
  });
  const fRow = await rowOf(f.F.id);
  check(
    "get: F cannot be removed",
    (await f.reports.get({ publicId })).recipients.find((r) => r.id === fRow.id)
      ?.canRemove === false,
  );
  await expectRefused(
    "a recipient that opened the report in the portal cannot be removed",
    () => f.reports.removeRecipient({ publicId, recipientId: fRow.id }),
    /opened the report in the investor portal/,
    "BAD_REQUEST",
  );
  eq(
    "history kept: B's email log and F's portal log are still there",
    [
      await db.emailLog.count({
        where: {
          companyId: f.c.id,
          relatedId: report.id,
          stakeholderId: f.B.id,
        },
      }),
      await db.portalAccessLog.count({
        where: { companyId: f.c.id, stakeholderId: f.F.id },
      }),
    ].join(","),
    "1,1",
  );
  await expectRefused(
    "a DRAFT has no recipients to remove",
    async () => {
      const d = await f.reports.create({
        type: "NOTICE",
        noticeKind: "GENERAL",
      });
      return f.reports.removeRecipient({
        publicId: d.publicId,
        recipientId: fRow.id,
      });
    },
    /only from a released report/,
    "BAD_REQUEST",
  );

  section(
    "P4b: removeRecipient against an email job that claims at the same moment",
  );
  const g = await fixtureCompany("p4b-remove-race");
  const q = await quarterlyDraft(g);
  await g.reports.release({
    publicId: q,
    stakeholderIds: [g.A.id, g.B.id, g.C.id],
    email: false,
  });
  const gA = (await recipientsOf(g, q)).find((r) => r.stakeholderId === g.A.id);
  // The job's claim holds the row (uncommitted) while the removal runs.
  let releaseClaim: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const claim = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE "MemberReportRecipient" SET "sendCount" = 1
        WHERE "id" = ${gA?.id ?? ""} AND "sendCount" <= 0`;
      await gate;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  await new Promise((r) => setTimeout(r, 200));
  const removal = errorOf(() =>
    g.reports.removeRecipient({ publicId: q, recipientId: gA?.id ?? "" }),
  );
  await new Promise((r) => setTimeout(r, 600));
  releaseClaim();
  await claim;
  const raced = await removal;
  check(
    "the claim committed first: the removal is refused (CONFLICT), the row stays",
    raced !== null && raced.code === "CONFLICT",
    raced ? `${raced.code}: ${raced.message}` : "it succeeded",
  );
  eq(
    "A's row still exists",
    (await recipientsOf(g, q)).some((r) => r.id === gA?.id),
    true,
  );
  eq(
    "no removal audit",
    await db.audit.count({
      where: { companyId: g.c.id, action: "memberReport.recipient-removed" },
    }),
    0,
  );
  // The other order: the removal holds the row; the job's claim then finds nothing.
  const gB = (await recipientsOf(g, q)).find((r) => r.stakeholderId === g.B.id);
  const results = await Promise.all([
    errorOf(() =>
      g.reports.removeRecipient({ publicId: q, recipientId: gB?.id ?? "" }),
    ),
    errorOf(() => runReportJob(gB?.id ?? "", 0)),
  ]);
  const gone = !(await recipientsOf(g, q)).some((r) => r.id === gB?.id);
  const mailed = await db.emailLog.count({
    where: { companyId: g.c.id, stakeholderId: g.B.id },
  });
  check(
    "removal and job together: either removed and not emailed, or emailed and kept",
    (gone && mailed === 0 && results[0] === null) ||
      (!gone && mailed === 1 && results[0] !== null),
    JSON.stringify({ gone, mailed, results }),
  );
}

/** Finding 3: nothing is emailed while the report is unpublished. */
async function unpublishedRefusals() {
  section("P4b finding 3: an unpublished report cannot be emailed");
  const f = await fixtureCompany("p4b-unpublished");
  const publicId = await quarterlyDraft(f);
  await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.B.id],
    email: false,
  });
  await f.reports.unpublish({ publicId });
  const a = (await recipientsOf(f, publicId))[0];
  const e0 = emitted.length;
  for (const [label, run] of [
    ["resend to all", () => f.reports.resend({ publicId })],
    [
      "email all not yet emailed",
      () => f.reports.resend({ publicId, scope: "NOT_EMAILED" }),
    ],
    [
      "email one recipient",
      () => f.reports.resend({ publicId, recipientId: a?.id ?? "" }),
    ],
    [
      "replace a link",
      () => f.reports.replaceLink({ publicId, recipientId: a?.id ?? "" }),
    ],
    [
      "add a recipient with email",
      () =>
        f.reports.addRecipients({
          publicId,
          stakeholderIds: [f.C.id],
          email: true,
        }),
    ],
  ] as const) {
    await expectRefused(
      `${label}: refused`,
      run,
      /unpublished\. Publish it again before emailing it/,
      "BAD_REQUEST",
    );
  }
  eq("nothing was handed to the queue", emailJobsSince(e0).length, 0);
  eq(
    "no link was replaced",
    (await recipientsOf(f, publicId)).every((r) => r.tokenVersion === 1),
    true,
  );
  const add = await f.reports.addRecipients({
    publicId,
    stakeholderIds: [f.C.id],
    email: false,
  });
  eq("adding without email is allowed while unpublished", add.added.length, 1);
  await f.reports.publish({ publicId });
  const ok = await f.reports.resend({ publicId, scope: "NOT_EMAILED" });
  eq("published again: the three not yet emailed are queued", ok.queued, 3);
}

/**
 * P4c review finding: a report email job that runs while the report is
 * unpublished sends nothing, does not fail, and leaves the recipient "not
 * emailed" (no claim, no `sentAt`, still removable). Published again, the
 * same queued job delivers.
 */
async function unpublishedAtSendTime() {
  section("P4c: the email job skips a report unpublished at send time");
  const f = await fixtureCompany("p4c-unpublished-job");
  const publicId = await quarterlyDraft(f);
  const e0 = emitted.length;
  await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.B.id],
    email: true,
  });
  const jobs = emailJobsSince(e0);
  eq("two report emails queued at release", jobs.length, 2);
  await f.reports.unpublish({ publicId });
  const report = await reportRow(f, publicId);
  const deliveries = () =>
    db.emailLog.count({
      where: {
        companyId: f.c.id,
        relatedType: "memberReport",
        relatedId: report.id,
      },
    });
  for (const j of jobs) {
    const err = await errorOf(() =>
      runReportJob(String(j.data.recipientId), Number(j.data.seq)),
    );
    check("the job ends without an error", err === null, err?.message ?? "");
  }
  eq("no email was sent (no email-log row)", await deliveries(), 0);
  const rows = await recipientsOf(f, publicId);
  eq(
    "no recipient is marked emailed or claimed",
    JSON.stringify(rows.map((r) => [r.sentAt, r.sendCount, r.emailLogId])),
    JSON.stringify(rows.map(() => [null, 0, null])),
  );
  const view = await f.reports.get({ publicId });
  eq(
    "get: both still not emailed and removable",
    JSON.stringify(view.recipients.map((r) => [r.emailedAt, r.canRemove])),
    JSON.stringify([
      [null, true],
      [null, true],
    ]),
  );
  await f.reports.publish({ publicId });
  for (const j of jobs) {
    await runReportJob(String(j.data.recipientId), Number(j.data.seq));
  }
  const after = await recipientsOf(f, publicId);
  eq(
    "published again: the same jobs deliver (claimed once, emailed)",
    JSON.stringify(after.map((r) => [r.sendCount, r.sentAt !== null])),
    JSON.stringify(after.map(() => [1, true])),
  );
  eq("two delivery emails logged", await deliveries(), 2);
}

/** Invitations with a release (P27): outcomes, one email per person, RBAC, mail guard, concurrency. */
async function invitationsOnRelease() {
  section("P4b: release with inviteMissing");
  const f = await fixtureCompany("p4b-invite");
  const publicId = await quarterlyDraft(f);
  const shared = uniqueAddress("shared");
  const bAddr = uniqueAddress("b");
  const cAddr = uniqueAddress("c");
  portalEmails.add(shared);
  // A and F share one notice address (one person, two holdings); B's notice
  // address already has access to B; C's was disabled by the team.
  await db.stakeholder.update({
    where: { id: f.A.id },
    data: { noticeEmail: shared },
  });
  await db.stakeholder.update({
    where: { id: f.F.id },
    data: { noticeEmail: shared },
  });
  await db.stakeholder.update({
    where: { id: f.B.id },
    data: { noticeEmail: bAddr },
  });
  await db.stakeholder.update({
    where: { id: f.C.id },
    data: { noticeEmail: cAddr },
  });
  await portalAccessFor(f, bAddr, f.B.id);
  await portalAccessFor(f, cAddr, f.C.id, { status: "DISABLED" });
  const ids = [f.A.id, f.B.id, f.C.id, f.F.id];
  const pre = accountEmails.length;

  const options = await f.reports.audienceOptions({ publicId });
  eq(
    "audienceOptions: the notice address's own access per holder",
    ["A", "B", "C", "F"]
      .map(
        (k) =>
          options.holders.find((h) => f.holders.get(h.stakeholderId) === k)
            ?.noticeAddressAccess,
      )
      .join(","),
    "NONE,ACTIVE,DISABLED,NONE",
  );

  // RBAC: governance update without portal create.
  const governanceOnly = await customCaller(f, [
    { subject: "governance", actions: ["read", "update"] },
  ]);
  await expectRefused(
    "inviteMissing without portal: create is FORBIDDEN",
    () =>
      governanceOnly.release({
        publicId,
        stakeholderIds: ids,
        email: true,
        inviteMissing: true,
      }),
    /needs the portal permission/,
    "FORBIDDEN",
  );
  const other = await f.reports.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await f.reports.update({
    publicId: other.publicId,
    title: "Notice",
    figures: {},
    commentary: [paragraph("A notice.")],
  });
  const plain = await errorOf(() =>
    governanceOnly.release({
      publicId: other.publicId,
      stakeholderIds: [f.A.id],
      email: false,
    }),
  );
  check(
    "the same caller without inviteMissing is accepted",
    plain === null,
    plain?.message ?? "",
  );
  const plainAdd = await errorOf(() =>
    governanceOnly.addRecipients({
      publicId: other.publicId,
      stakeholderIds: [f.B.id],
      email: false,
    }),
  );
  check(
    "and may add recipients without inviteMissing",
    plainAdd === null,
    plainAdd?.message ?? "",
  );
  await expectRefused(
    "but not add recipients with inviteMissing",
    () =>
      governanceOnly.addRecipients({
        publicId: other.publicId,
        stakeholderIds: [f.C.id],
        email: false,
        inviteMissing: true,
      }),
    /needs the portal permission/,
    "FORBIDDEN",
  );
  // Mail guard: production with the mail catcher refuses the invitations
  // even for a portal-only release.
  const penv = process.env as Record<string, string | undefined>;
  const previous = penv.NODE_ENV;
  penv.NODE_ENV = "production";
  try {
    await expectRefused(
      "inviteMissing in production with the mail catcher is refused (even without email)",
      () =>
        f.reports.release({
          publicId,
          stakeholderIds: ids,
          email: false,
          inviteMissing: true,
        }),
      /Emails to Members would only reach the local mail catcher/,
      "BAD_REQUEST",
    );
  } finally {
    penv.NODE_ENV = previous;
  }
  eq(
    "still a DRAFT, no access created",
    [
      (await reportRow(f, publicId)).status,
      await db.portalAccess.count({ where: { companyId: f.c.id } }),
    ].join(","),
    "DRAFT,2",
  );
  eq("no invitation email", accountEmails.length - pre, 0);

  section("P4b: two concurrent releases with inviteMissing");
  const a0 = accountEmails.length;
  const runs = await Promise.allSettled([
    f.reports.release({
      publicId,
      stakeholderIds: ids,
      email: true,
      inviteMissing: true,
    }),
    f.reports.release({
      publicId,
      stakeholderIds: ids,
      email: true,
      inviteMissing: true,
    }),
  ]);
  const won = runs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  eq("exactly one release", won.length, 1);
  eq(
    "the result lists each holder's invitation: A and F created, B already active, C left disabled",
    (won[0]?.invitations ?? [])
      .map((l) => `${f.holders.get(l.stakeholderId)}:${l.outcome}`)
      .sort()
      .join(","),
    "A:CREATED,B:ALREADY_ACTIVE,C:LEFT_DISABLED,F:CREATED",
  );
  eq(
    "one invitation email queued (one person), four report emails",
    [won[0]?.invitationsQueued, won[0]?.queued].join(","),
    "1,4",
  );
  const sharedUser = await db.portalUser.findUniqueOrThrow({
    where: { email: shared },
  });
  const accesses = await db.portalAccess.findMany({
    where: { companyId: f.c.id },
    include: { portalUser: { select: { email: true } } },
  });
  eq(
    "accesses: A and F at the shared address (new), B unchanged, C still DISABLED",
    accesses
      .map(
        (x) =>
          `${f.holders.get(x.stakeholderId)}:${x.portalUser.email === shared ? "shared" : "own"}:${x.status}`,
      )
      .sort()
      .join(","),
    "A:shared:ACTIVE,B:own:ACTIVE,C:own:DISABLED,F:shared:ACTIVE",
  );
  const invites = accountEmails.slice(a0);
  eq(
    "one invitation email for the one person invited",
    invites.map((e) => e.kind).join(","),
    "INVITE",
  );
  const tokens = await db.portalAccountToken.findMany({
    where: { portalUserId: sharedUser.id },
  });
  const live = tokens.filter((t) => t.usedAt === null);
  eq(
    "two set-password tokens were issued (one per access), one still usable",
    [tokens.length, live.length].join(","),
    "2,1",
  );
  eq(
    "the queued email carries the usable token",
    invites[0]?.tokenId,
    live[0]?.id,
  );
  eq(
    "two portal.access-invited audit rows (A and F)",
    await db.audit.count({
      where: { companyId: f.c.id, action: "portal.access-invited" },
    }),
    2,
  );
  const releasedAudit = await db.audit.findFirst({
    where: {
      companyId: f.c.id,
      action: "memberReport.released",
      summary: { contains: "Q3 2026 report to Members" },
    },
  });
  check(
    "the release audit lists the invitations and the access left disabled",
    /invited 2 addresses to the investor portal \(.*A Preferred at .*\); portal access left disabled for C Common at /.test(
      releasedAudit?.summary ?? "",
    ) && /F Interest at /.test(releasedAudit?.summary ?? ""),
    releasedAudit?.summary ?? "",
  );
  eq(
    "four recipients (the audience confirmed)",
    (await recipientsOf(f, publicId)).length,
    4,
  );

  section(
    "P4b: addRecipients with inviteMissing; a person with a password gets one access-added email",
  );
  const g = await fixtureCompany("p4b-invite-add");
  const q = await quarterlyDraft(g);
  const known = uniqueAddress("known");
  // The person already has a portal password (another holder).
  await portalAccessFor(g, known, g.A.id, { passwordSetAt: new Date() });
  await db.stakeholder.update({
    where: { id: g.B.id },
    data: { noticeEmail: known },
  });
  await db.stakeholder.update({
    where: { id: g.C.id },
    data: { noticeEmail: "  " },
  });
  await g.reports.release({
    publicId: q,
    stakeholderIds: [g.A.id],
    email: false,
  });
  const gRows = async () =>
    (await recipientsOf(g, q)).map((r) => g.holders.get(r.stakeholderId));
  const gEnv = process.env as Record<string, string | undefined>;
  const gPrevious = gEnv.NODE_ENV;
  gEnv.NODE_ENV = "production";
  try {
    await expectRefused(
      "addRecipients with email in production with the mail catcher is refused",
      () =>
        g.reports.addRecipients({
          publicId: q,
          stakeholderIds: [g.B.id],
          email: true,
        }),
      /Emails to Members would only reach the local mail catcher/,
      "BAD_REQUEST",
    );
    await expectRefused(
      "addRecipients with inviteMissing (no email) is refused too",
      () =>
        g.reports.addRecipients({
          publicId: q,
          stakeholderIds: [g.B.id],
          email: false,
          inviteMissing: true,
        }),
      /Emails to Members would only reach the local mail catcher/,
      "BAD_REQUEST",
    );
    eq(
      "nothing written: A is the only recipient, B has no access",
      [
        (await gRows()).join("+"),
        await db.portalAccess.count({
          where: { companyId: g.c.id, stakeholderId: g.B.id },
        }),
      ].join(","),
      "A,0",
    );
    const portalOnly = await errorOf(() =>
      g.reports.addRecipients({
        publicId: q,
        stakeholderIds: [g.F.id],
        email: false,
      }),
    );
    check(
      "addRecipients without email or invitations needs no mail service",
      portalOnly === null,
      portalOnly?.message ?? "",
    );
  } finally {
    gEnv.NODE_ENV = gPrevious;
  }
  eq("F was added", (await gRows()).join("+"), "A+F");
  const g0 = accountEmails.length;
  const both = await Promise.all([
    g.reports.addRecipients({
      publicId: q,
      stakeholderIds: [g.B.id, g.C.id],
      email: false,
      inviteMissing: true,
    }),
    g.reports.addRecipients({
      publicId: q,
      stakeholderIds: [g.B.id, g.C.id],
      email: false,
      inviteMissing: true,
    }),
  ]);
  const lines = both.flatMap((r) => r.invitations);
  eq(
    "one call invited: B created, C has no notice address; the other added nothing",
    lines
      .map((l) => `${g.holders.get(l.stakeholderId)}:${l.outcome}`)
      .sort()
      .join(","),
    "B:CREATED,C:NO_ADDRESS",
  );
  check(
    "the result never says which email was sent",
    lines.every((l) => !("emailKind" in l)),
  );
  eq(
    "one access for B at that address",
    await db.portalAccess.count({
      where: { companyId: g.c.id, stakeholderId: g.B.id },
    }),
    1,
  );
  eq(
    "one email: access added, no token",
    accountEmails
      .slice(g0)
      .map((e) => `${e.kind}:${e.tokenId ?? "-"}`)
      .join(","),
    "ACCESS_ADDED:-",
  );
  const repeat = await errorOf(async () => {
    const d = await g.reports.create({ type: "NOTICE", noticeKind: "GENERAL" });
    await g.reports.update({
      publicId: d.publicId,
      title: "Notice",
      figures: {},
      commentary: [paragraph("x")],
    });
    const r = await g.reports.release({
      publicId: d.publicId,
      stakeholderIds: [g.B.id],
      email: false,
      inviteMissing: true,
    });
    if (
      r.invitations.map((l) => l.outcome).join() !== "ALREADY_ACTIVE" ||
      r.invitationsQueued !== 0
    ) {
      throw new Error(JSON.stringify(r.invitations));
    }
  });
  check(
    "inviting an address that already has access to the holder sends nothing",
    repeat === null,
    repeat?.message ?? "",
  );
}

/** Finding 4: the picker's portal state follows the member page card's rule. */
async function portalStateRule() {
  section("P4b finding 4: portal state = the member page card's rule");
  const f = await fixtureCompany("p4b-portal-state");
  const publicId = await quarterlyDraft(f);
  await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.B.id, f.C.id, f.F.id],
    email: false,
  });
  const hour = 3_600_000;
  const now = Date.now();
  // A: password set AFTER this company's invitation -> ACTIVE.
  await portalAccessFor(f, uniqueAddress("a"), f.A.id, {
    invitedAt: new Date(now - 2 * hour),
    passwordSetAt: new Date(now - hour),
  });
  // B: the person set a password BEFORE this invitation (an account of
  // another company): INVITED here; nothing about the other company shows.
  await portalAccessFor(f, uniqueAddress("b"), f.B.id, {
    invitedAt: new Date(now - hour),
    passwordSetAt: new Date(now - 2 * hour),
  });
  // C: same as B, but the person has opened C in the portal -> ACTIVE.
  await portalAccessFor(f, uniqueAddress("c"), f.C.id, {
    invitedAt: new Date(now - hour),
    passwordSetAt: new Date(now - 2 * hour),
    lastSeenAt: new Date(now - 60_000),
  });
  // F: only a DISABLED access -> NONE.
  await portalAccessFor(f, uniqueAddress("f"), f.F.id, {
    status: "DISABLED",
    passwordSetAt: new Date(now - hour),
  });
  const view = await f.reports.get({ publicId });
  const options = await f.reports.audienceOptions({ publicId });
  const admin = createCallerFactory(portalAdminRouter)(f.admin.context);
  const card = async (id: string) => {
    const rows = await admin.accessForHolder({ stakeholderId: id });
    return rows.some((r) => r.status === "ACTIVE")
      ? "ACTIVE"
      : rows.some((r) => r.status === "INVITED")
        ? "INVITED"
        : "NONE";
  };
  const order = [f.A.id, f.B.id, f.C.id, f.F.id];
  const fromGet = order.map(
    (id) => view.recipients.find((r) => r.stakeholderId === id)?.portal,
  );
  const fromOptions = order.map(
    (id) => options.holders.find((h) => h.stakeholderId === id)?.portal,
  );
  const fromCard: string[] = [];
  for (const id of order) fromCard.push(await card(id));
  eq(
    "get: A active, B invited (password set for another company), C active (opened), F none",
    fromGet.join(","),
    "ACTIVE,INVITED,ACTIVE,NONE",
  );
  eq("audienceOptions agrees", fromOptions.join(","), fromGet.join(","));
  eq(
    "the member page card (portalAdmin.accessForHolder) agrees",
    fromCard.join(","),
    fromGet.join(","),
  );
}

/** The readers of the report's `sentAt` (5.5): released is not emailed. */
async function sentAtReaders() {
  section("P4b: member page and transfer view tell released from emailed");
  const f = await fixtureCompany("p4b-readers");
  const publicId = await quarterlyDraft(f);
  await f.reports.release({
    publicId,
    stakeholderIds: [f.A.id, f.B.id],
    email: false,
  });
  const report = await reportRow(f, publicId);
  const governance = createCallerFactory(governanceRouter)(f.admin.context);
  const before = (
    await governance.memberActivity({ stakeholderId: f.A.id })
  ).reports.find((r) => r.reportPublicId === publicId);
  eq(
    "member page: a never-emailed recipient shows the release date and no email date",
    [
      before?.releasedAt?.toISOString() === report.sentAt?.toISOString(),
      before?.emailedAt,
    ].join(","),
    "true,",
  );
  const a = (await recipientsOf(f, publicId)).find(
    (r) => r.stakeholderId === f.A.id,
  );
  await f.reports.resend({ publicId, recipientId: a?.id ?? "" });
  await runReportJob(a?.id ?? "", 0);
  const after = (
    await governance.memberActivity({ stakeholderId: f.A.id })
  ).reports.find((r) => r.reportPublicId === publicId);
  check(
    "member page: once emailed, the email date is its own",
    after?.emailedAt != null &&
      after.releasedAt?.toISOString() === report.sentAt?.toISOString(),
  );

  const { publicId: notice, transferId } = await transferNoticeDraft(f);
  const transfers = createCallerFactory(unitTransferRouter)(f.admin.context);
  const transfer = await db.unitTransfer.findUniqueOrThrow({
    where: { id: transferId },
  });
  eq(
    "transfer view: a prepared copy is not released",
    (await transfers.get({ publicId: transfer.publicId })).noticeCopyReport
      ?.releasedAt,
    null,
  );
  await f.reports.release({
    publicId: notice,
    stakeholderIds: await defaultIds(f, notice),
    email: false,
  });
  const copy = (await transfers.get({ publicId: transfer.publicId }))
    .noticeCopyReport;
  eq(
    "transfer view: released, emailed to 0 of 1 (B, the other Preferred Member)",
    [copy?.releasedAt != null, copy?.emailedCount, copy?.recipientCount].join(
      ",",
    ),
    "true,0,1",
  );
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
        ["P4b: invitations", invitationsOnRelease],
        ["P4b: resend never adds", resendNeverAdds],
        ["P4b: add recipients", addRecipientsScenario],
        ["P4b: remove recipient", removeRecipientScenario],
        ["P4b: unpublished", unpublishedRefusals],
        ["P4c: unpublished at send time", unpublishedAtSendTime],
        ["P4b: portal state", portalStateRule],
        ["P4b: sentAt readers", sentAtReaders],
        ["P4b: portal and team users", cleanupP4b],
        ["K-1 files", deleteBuckets],
      ],
);
