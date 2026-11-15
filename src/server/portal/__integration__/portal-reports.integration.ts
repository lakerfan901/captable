/**
 * Portal report procedures (04-investor-portal.md P11, P12, P15, P16, P31;
 * package P5a) against the local database. Not part of `vitest run`. Run
 * from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-reports.integration.ts
 *
 * Companies are named `zz-portal-reports-…`, portal users
 * `zz-portal-reports.…@example.com`. No email is sent (every release is
 * portal-only) and pg-boss is not started (the filing job is captured).
 * Every row created is deleted at the end.
 *
 * Fixture. Company 1: A and B (Preferred Members), C (Common Member).
 * Company 2: F (Preferred Member). Portal user U1 has access to A, B and F
 * (two holders of one company, and one of another); U2 has access to C.
 * Reports of company 1: Q (quarterly, released to A and B), K (TAX_K1, to A
 * and B, K-1 files for A, B and C), N (notice, to A, B and C, with a shared
 * file and a file private to A), L (sent before the portal, publishedAt
 * null, to A), D (a draft with a hand-inserted recipient row for A).
 * Company 2: X (notice, to F, plus a hand-inserted recipient row for A).
 *
 * Covers: the visibility matrix (published / unpublished / republished ×
 * recipient / non-recipient × own / other company × disabled access, drafts,
 * reports released before the portal); frozen content only; K-1 privacy
 * across two holders of one portal user; attachments and the 60-second URL;
 * the export (parses as xlsx, only that report, no recipient data); log rows
 * and `canRemove` / `portalFirstViewedAt` in the team `get`; `findReport`;
 * Origin check; no storage key or bucket id in any response.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import ExcelJS from "exceljs";
import { reportFileJob } from "@/jobs/governance-report-file";
import { todayInZone } from "@/lib/governance/dates";
import type { PortalEventEnum } from "@/prisma/enums";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
import { signReportToken } from "@/server/governance/tokens";
import {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  errorOf,
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
} from "@/server/llc/__integration__/harness";
import { createPortalSession, portalCookieName } from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { memberReportViewRouter } from "@/trpc/routers/member-report-view-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";

setCompanyPrefix("zz-portal-reports-");
const EMAIL_PREFIX = "zz-portal-reports.";
const BASE = "http://localhost:3000";
const FACTS = { ip: "203.0.113.42", userAgent: "portal-reports-integration" };

// pg-boss is not started: the filing job a release queues is captured.
(reportFileJob as { emit: unknown }).emit = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Bookkeeping: rows the company cleanup cannot see

const portalUserIds: string[] = [];
const bucketIds: string[] = [];
/** Every response a portal procedure returned (fileUrl excepted), for the key scan. */
const responses: unknown[] = [];

async function newPortalUser(label: string) {
  const user = await db.portalUser.create({
    data: {
      email: `${EMAIL_PREFIX}${label}.${randomUUID().slice(0, 8)}@example.com`,
    },
  });
  portalUserIds.push(user.id);
  return user;
}

function grant(portalUserId: string, companyId: string, stakeholderId: string) {
  return db.portalAccess.create({
    data: {
      publicId: `pa_${randomUUID().replace(/-/g, "")}`,
      portalUserId,
      companyId,
      stakeholderId,
      invitedById: "portal-reports-integration",
    },
  });
}

async function sessionFor(portalUserId: string): Promise<string> {
  const { token } = await createPortalSession(db, {
    portalUserId,
    ip: FACTS.ip,
    userAgent: FACTS.userAgent,
    now: new Date(),
  });
  return token;
}

/** A browser caller: portal cookie, the app's Origin, the client's address. */
function portalCaller(
  sessionToken: string,
  opts: { origin?: string | null; rsc?: boolean } = {},
) {
  const headers = new Headers();
  headers.set("cookie", `${portalCookieName()}=${sessionToken}`);
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.rsc) headers.set("x-trpc-source", "rsc");
  return createCallerFactory(portalRouter)({
    db,
    session: null,
    requestIp: opts.rsc ? "127.0.0.1" : FACTS.ip,
    userAgent: FACTS.userAgent,
    headers,
  } as never);
}

const viewCaller = () =>
  createCallerFactory(memberReportViewRouter)({
    db,
    session: null,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers: new Headers(),
  } as never);

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  const error = await errorOf(async () => {
    responses.push(await fn());
  });
  return error === null ? "OK" : (error.code ?? error.message);
}

async function keep<T>(value: Promise<T>): Promise<T> {
  const v = await value;
  responses.push(v);
  return v;
}

function logRows(where: {
  portalUserId: string;
  event?: PortalEventEnum;
  targetId?: string;
}) {
  return db.portalAccessLog.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

function paragraph(text: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

async function testBucket(c: TestCompany, label: string) {
  const key = `${c.id}/zz-portal-reports/${label}-${randomUUID().slice(0, 8)}.pdf`;
  const bucket = await db.bucket.create({
    data: {
      name: `${label}.pdf`,
      key,
      mimeType: "application/pdf",
      size: 1,
      tags: [],
    },
  });
  bucketIds.push(bucket.id);
  return bucket;
}

// ---------------------------------------------------------------------------
// Fixture

type Admin = Awaited<ReturnType<typeof createAdmin>>;
const reportsCallerOf = (admin: Admin) =>
  createCallerFactory(memberReportRouter)(admin.context);
type ReportsCaller = ReturnType<typeof reportsCallerOf>;
interface World {
  c1: TestCompany;
  c2: TestCompany;
  A: { id: string; name: string; email: string };
  B: { id: string; name: string; email: string };
  C: { id: string; name: string; email: string };
  F: { id: string; name: string; email: string };
  admin1: Admin;
  admin2: Admin;
  reports1: ReportsCaller;
  reports2: ReportsCaller;
  U1: { id: string; session: string };
  U2: { id: string; session: string };
  accA: { id: string; publicId: string };
  accB: { id: string; publicId: string };
  accC: { id: string; publicId: string };
  accF: { id: string; publicId: string };
  Q: string;
  K: string;
  N: string;
  L: string;
  D: string;
  X: string;
  k1: Record<"A" | "B" | "C", { id: string; key: string; bucketId: string }>;
  nShared: { id: string; key: string; bucketId: string };
  nPrivateA: { id: string; key: string; bucketId: string };
  frozenQTitle: string;
}
let w: World;

const reportRow = (companyId: string, publicId: string) =>
  db.memberReport.findFirstOrThrow({ where: { publicId, companyId } });

async function quarterlyDraft(r: ReportsCaller, c: TestCompany) {
  const { publicId } = await r.create({
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: 3,
  });
  const row = await reportRow(c.id, publicId);
  const figures = JSON.parse(JSON.stringify(row.figures)) as {
    utilization: { bps: number | null };
    managerPayments: { confirmedNone: boolean };
  };
  figures.utilization.bps = 8_500;
  figures.managerPayments.confirmedNone = true;
  await r.update({
    publicId,
    title: "Q3 2026 report to Members",
    figures,
    commentary: [paragraph("Operations were steady in the quarter.")],
  });
  return publicId;
}

async function noticeDraft(r: ReportsCaller, title: string) {
  const { publicId } = await r.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await r.update({
    publicId,
    title,
    figures: {},
    commentary: [paragraph(`${title}: body.`)],
  });
  return publicId;
}

async function attach(
  c: TestCompany,
  reportPublicId: string,
  label: string,
  stakeholderId: string | null,
  kind: "K1" | "GENERAL",
) {
  const report = await reportRow(c.id, reportPublicId);
  const bucket = await testBucket(c, label);
  const row = await db.memberReportAttachment.create({
    data: {
      reportId: report.id,
      companyId: c.id,
      kind,
      name: `${label}.pdf`,
      bucketId: bucket.id,
      stakeholderId,
    },
  });
  return { id: row.id, key: bucket.key, bucketId: bucket.id };
}

function handRecipient(
  reportId: string,
  companyId: string,
  holder: { id: string; name: string; email: string },
  opts: { sent?: boolean } = {},
) {
  const now = new Date();
  return db.memberReportRecipient.create({
    data: {
      reportId,
      companyId,
      stakeholderId: holder.id,
      name: holder.name,
      email: holder.email,
      tokenExpiresAt: new Date(now.getTime() + 86_400_000),
      sentAt: opts.sent ? now : null,
      sendCount: opts.sent ? 1 : 0,
    },
  });
}

async function setup() {
  section("setup");
  const c1 = await createCompany("one");
  const c2 = await createCompany("two");
  const A = await newMember(c1, "A Preferred");
  const B = await newMember(c1, "B Preferred");
  const C = await newMember(c1, "C Common");
  const F = await newMember(c2, "F Preferred");
  await subscribe(c1, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-10",
  });
  await subscribe(c1, B.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  await issueCommon(c1, C.id, "100", "2026-11-11");
  await subscribe(c2, F.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  setToday(todayInZone(new Date(), c1.timezone));
  const admin1 = await createAdmin(c1);
  const admin2 = await createAdmin(c2);
  const reports1 = reportsCallerOf(admin1);
  const reports2 = reportsCallerOf(admin2);

  // Q: quarterly, released to A and B (portal only).
  const Q = await quarterlyDraft(reports1, c1);
  await reports1.release({
    publicId: Q,
    stakeholderIds: [A.id, B.id],
    email: false,
  });

  // K: TAX_K1 for 2026, K-1 files for A, B and C; released to A and B.
  await inTx((tx) => syncComplianceDeadlines(tx, c1.id, new Date()));
  const target = await db.complianceDeadline.findFirstOrThrow({
    where: { companyId: c1.id, dedupeKey: "K1_TARGET:2026" },
    select: { id: true },
  });
  const { publicId: K } = await reports1.create({
    type: "TAX_K1",
    fiscalYear: 2026,
    relatedType: "COMPLIANCE_DEADLINE",
    relatedId: target.id,
  });
  const k1 = {
    A: await attach(c1, K, "K-1 A", A.id, "K1"),
    B: await attach(c1, K, "K-1 B", B.id, "K1"),
    C: await attach(c1, K, "K-1 C", C.id, "K1"),
  };
  await reports1.release({
    publicId: K,
    stakeholderIds: [A.id, B.id],
    email: false,
  });

  // N: a notice to A, B and C with one shared file and one private to A.
  const N = await noticeDraft(reports1, "Notice to Members");
  const nShared = await attach(c1, N, "Shared letter", null, "GENERAL");
  const nPrivateA = await attach(c1, N, "Letter for A", A.id, "GENERAL");
  await reports1.release({
    publicId: N,
    stakeholderIds: [A.id, B.id, C.id],
    email: false,
  });

  // L: sent before the portal (publishedAt null), to A.
  const lRow = await db.memberReport.create({
    data: {
      publicId: `zz-portal-reports-${randomUUID().slice(0, 12)}`,
      companyId: c1.id,
      type: "NOTICE",
      status: "SENT",
      noticeKind: "GENERAL",
      title: "Old notice",
      commentary: [],
      figures: {},
      frozenContent: { title: "Old notice", doc: [] },
      frozenHash: "x",
      sentAt: new Date(),
      authorId: "portal-reports-integration",
    },
  });
  await handRecipient(lRow.id, c1.id, A, { sent: true });

  // D: a draft with a hand-inserted recipient row for A.
  const D = await noticeDraft(reports1, "Draft notice");
  await handRecipient((await reportRow(c1.id, D)).id, c1.id, A);

  // X: company 2's notice to F, and a stray recipient row for A on it.
  const X = await noticeDraft(reports2, "Company two notice");
  await reports2.release({ publicId: X, stakeholderIds: [F.id], email: false });
  await handRecipient((await reportRow(c2.id, X)).id, c2.id, A);

  // Portal users.
  const u1 = await newPortalUser("u1");
  const u2 = await newPortalUser("u2");
  const accA = await grant(u1.id, c1.id, A.id);
  const accB = await grant(u1.id, c1.id, B.id);
  const accF = await grant(u1.id, c2.id, F.id);
  const accC = await grant(u2.id, c1.id, C.id);

  const frozenQTitle = "Q3 2026 report to Members";
  w = {
    c1,
    c2,
    A,
    B,
    C,
    F,
    admin1,
    admin2,
    reports1,
    reports2,
    U1: { id: u1.id, session: await sessionFor(u1.id) },
    U2: { id: u2.id, session: await sessionFor(u2.id) },
    accA,
    accB,
    accC,
    accF,
    Q,
    K,
    N,
    L: lRow.publicId,
    D,
    X,
    k1,
    nShared,
    nPrivateA,
    frozenQTitle,
  };
  const q = await reportRow(c1.id, Q);
  check(
    "Q released and published",
    q.status === "SENT" && q.publishedAt !== null,
  );
  check("fixtures created", true);
}

const team = () => w.reports1;

// ---------------------------------------------------------------------------
// 1. Visibility matrix

const listIds = async (session: string, access: string) =>
  (await keep(portalCaller(session).reports.list({ access }))).map((r) => r.id);

async function visibility() {
  section(
    "1. visibility: recipient / non-recipient / other company / drafts / before the portal",
  );
  const u1 = portalCaller(w.U1.session);
  const u2 = portalCaller(w.U2.session);

  const aList = await listIds(w.U1.session, w.accA.publicId);
  eq(
    "A sees Q, K and N (not L, D or X)",
    [w.Q, w.K, w.N].every((id) => aList.includes(id)) && aList.length === 3,
    true,
  );
  const bList = await listIds(w.U1.session, w.accB.publicId);
  eq("B (same portal user) sees Q, K, N", bList.length, 3);
  const cList = await listIds(w.U2.session, w.accC.publicId);
  eq("C (not selected for Q or K) sees only N", cList.join(","), w.N);
  const fList = await listIds(w.U1.session, w.accF.publicId);
  eq("F (company 2) sees only X", fList.join(","), w.X);

  for (const [label, access, id] of [
    ["C: Q (non-recipient)", w.accC.publicId, w.Q],
    ["C: K (not selected, even with a K-1 attached)", w.accC.publicId, w.K],
    ["A: L (released before the portal)", w.accA.publicId, w.L],
    ["A: D (draft, even with a recipient row)", w.accA.publicId, w.D],
    [
      "A: X (other company, even with a stray recipient row)",
      w.accA.publicId,
      w.X,
    ],
    ["F: Q (other company)", w.accF.publicId, w.Q],
    ["A: an unknown id", w.accA.publicId, "zz-no-such-report"],
  ] as const) {
    const caller = access === w.accC.publicId ? u2 : u1;
    eq(
      `${label}: get is NOT_FOUND`,
      await codeOf(() => caller.reports.get({ access, reportId: id })),
      "NOT_FOUND",
    );
    eq(
      `${label}: markViewed is NOT_FOUND`,
      await codeOf(() => caller.reports.markViewed({ access, reportId: id })),
      "NOT_FOUND",
    );
  }

  // The error is message-less and identical for every kind of miss.
  const messages = new Set<string>();
  for (const id of [w.L, w.D, w.X, "zz-no-such-report"]) {
    const e = await errorOf(() =>
      u1.reports.get({ access: w.accA.publicId, reportId: id }),
    );
    messages.add(`${e?.code}:${e?.message}`);
  }
  eq("every miss is the same error", messages.size, 1);

  // Another user's access id is NOT_FOUND (P10).
  eq(
    "U2 with A's access id: NOT_FOUND",
    await codeOf(() => u2.reports.list({ access: w.accA.publicId })),
    "NOT_FOUND",
  );

  section("1b. reports released before the portal keep their emailed link");
  const lRow = await reportRow(w.c1.id, w.L);
  const lRecipient = await db.memberReportRecipient.findFirstOrThrow({
    where: { reportId: lRow.id, stakeholderId: w.A.id },
  });
  const page = await viewCaller().view({
    token: await signReportToken(lRecipient),
  });
  eq("L: the token page still opens it", page.state, "OK");
  eq(
    "findReport for L: no match (not in the portal)",
    (await keep(u1.findReport({ reportId: w.L }))).matches.length,
    0,
  );
}

async function unpublishCycle() {
  section("2. unpublish / republish / disabled access");
  const u1 = portalCaller(w.U1.session);
  await team().unpublish({ publicId: w.Q });
  check(
    "after unpublish: Q is not in A's list",
    !(await listIds(w.U1.session, w.accA.publicId)).includes(w.Q),
  );
  for (const [label, fn] of [
    ["get", () => u1.reports.get({ access: w.accA.publicId, reportId: w.Q })],
    [
      "markViewed",
      () => u1.reports.markViewed({ access: w.accA.publicId, reportId: w.Q }),
    ],
    [
      "exportXlsx",
      () => u1.reports.exportXlsx({ access: w.accA.publicId, reportId: w.Q }),
    ],
  ] as const) {
    eq(`after unpublish: ${label} is NOT_FOUND`, await codeOf(fn), "NOT_FOUND");
  }
  eq(
    "after unpublish: findReport has no match",
    (await keep(u1.findReport({ reportId: w.Q }))).matches.length,
    0,
  );
  await team().publish({ publicId: w.Q });
  check(
    "after publishing again: Q is back for A",
    (await listIds(w.U1.session, w.accA.publicId)).includes(w.Q),
  );
  eq(
    "and get works",
    await codeOf(() =>
      u1.reports.get({ access: w.accA.publicId, reportId: w.Q }),
    ),
    "OK",
  );

  // Disabled access: A's id stops working at once, B and F keep working.
  await db.portalAccess.update({
    where: { id: w.accA.id },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  eq(
    "A's access disabled: list is NOT_FOUND",
    await codeOf(() => u1.reports.list({ access: w.accA.publicId })),
    "NOT_FOUND",
  );
  eq(
    "A's access disabled: get is NOT_FOUND",
    await codeOf(() =>
      u1.reports.get({ access: w.accA.publicId, reportId: w.Q }),
    ),
    "NOT_FOUND",
  );
  eq(
    "A's access disabled: findReport(Q) lists only B",
    (await keep(u1.findReport({ reportId: w.Q }))).matches
      .map((m) => m.holderName)
      .join(","),
    w.B.name,
  );
  eq(
    "B's access still works",
    await codeOf(() => u1.reports.list({ access: w.accB.publicId })),
    "OK",
  );
  await db.portalAccess.update({
    where: { id: w.accA.id },
    data: { status: "ACTIVE", disabledAt: null },
  });
}

async function frozenAndFind() {
  section("3. frozen content, output shape, findReport");
  const u1 = portalCaller(w.U1.session);
  // The live columns change after release; the portal shows the frozen ones.
  const before = await reportRow(w.c1.id, w.Q);
  await db.memberReport.update({
    where: { id: before.id },
    data: {
      title: "LIVE TITLE MUST NOT SHOW",
      commentary: [paragraph("LIVE COMMENTARY MUST NOT SHOW")],
      // A live figure that differs from the frozen one (utilization 85%).
      figures: {
        ...(before.figures as Record<string, unknown>),
        utilization: { bps: 1_234, note: "LIVE NOTE MUST NOT SHOW" },
      },
    },
  });
  const page = await keep(
    u1.reports.get({ access: w.accA.publicId, reportId: w.Q }),
  );
  eq("get: frozen title", page.report.title, w.frozenQTitle);
  check(
    "get: the live draft text does not appear",
    !JSON.stringify(page).includes("MUST NOT SHOW"),
  );
  const frozen = before.frozenContent as { figures?: unknown };
  check(
    "get: figures are the frozen figures",
    isDeepStrictEqual(page.report.figures, frozen.figures),
  );
  eq(
    "get: the frozen utilization (85%)",
    page.report.figures?.utilization.bps,
    8_500,
  );
  eq("get: holderName is A", page.holderName, w.A.name);
  eq("get: the report id is the public id", page.report.id, w.Q);
  eq("get: Q is exportable", page.exportable, true);
  check(
    "get: no recipient name, email or holder id of B",
    !JSON.stringify(page).includes(w.B.name) &&
      !JSON.stringify(page).includes(w.B.email) &&
      !JSON.stringify(page).includes(w.B.id),
  );
  const list = await keep(u1.reports.list({ access: w.accA.publicId }));
  const qItem = list.find((r) => r.id === w.Q);
  eq("list: frozen title", qItem?.title, w.frozenQTitle);
  eq("list: Q exportable", qItem?.exportable, true);
  eq(
    "list: K not exportable",
    list.find((r) => r.id === w.K)?.exportable,
    false,
  );
  eq(
    "list: K has own files for A",
    list.find((r) => r.id === w.K)?.hasOwnFiles,
    true,
  );
  eq("list: Q has no own files", qItem?.hasOwnFiles, false);
  const notice = await keep(
    u1.reports.get({ access: w.accA.publicId, reportId: w.N }),
  );
  eq("get: a notice has no figures", notice.report.figures, null);
  eq("get: a notice is not exportable", notice.exportable, false);

  section("3b. findReport");
  const both = await keep(u1.findReport({ reportId: w.Q }));
  eq(
    "U1 (A and B are recipients): two matches, one per holder",
    both.matches.map((m) => m.holderName).join(","),
    [w.A.name, w.B.name].sort((a, b) => a.localeCompare(b)).join(","),
  );
  eq(
    "the matches name the access public ids",
    both.matches
      .map((m) => m.access)
      .sort()
      .join(","),
    [w.accA.publicId, w.accB.publicId].sort().join(","),
  );
  eq(
    "U1 for X: only F (the stray row for A in company 2 grants nothing)",
    (await keep(u1.findReport({ reportId: w.X }))).matches
      .map((m) => m.access)
      .join(","),
    w.accF.publicId,
  );
  const u2 = portalCaller(w.U2.session);
  eq(
    "U2 (C is not a recipient of Q): no match",
    (await keep(u2.findReport({ reportId: w.Q }))).matches.length,
    0,
  );
  eq(
    "unknown report: no match",
    (await keep(u1.findReport({ reportId: "zz-no-such-report" }))).matches
      .length,
    0,
  );
}

// ---------------------------------------------------------------------------
// 4. K-1 privacy across two holders of one portal user, attachments, URLs

function assertUrlOnly(label: string, value: unknown) {
  const keys = Object.keys(value as object);
  eq(`${label}: the response has only "url"`, keys.join(","), "url");
  const url = (value as { url: string }).url;
  check(
    `${label}: the URL expires after 60 seconds`,
    /X-Amz-Expires=60(&|$)/.test(url),
    url.slice(0, 80),
  );
}

async function k1Privacy() {
  section("4. K-1 privacy: one portal user, holders A and B");
  const u1 = portalCaller(w.U1.session);
  const asA = await keep(
    u1.reports.get({ access: w.accA.publicId, reportId: w.K }),
  );
  eq(
    "acting as A: only A's K-1",
    asA.attachments.map((a) => a.id).join(","),
    w.k1.A.id,
  );
  eq("A's K-1 is marked private", asA.attachments[0]?.private, true);
  const asB = await keep(
    u1.reports.get({ access: w.accB.publicId, reportId: w.K }),
  );
  eq(
    "acting as B: only B's K-1",
    asB.attachments.map((a) => a.id).join(","),
    w.k1.B.id,
  );
  for (const [label, access, attachmentId] of [
    ["as A, B's K-1", w.accA.publicId, w.k1.B.id],
    ["as A, C's K-1", w.accA.publicId, w.k1.C.id],
    ["as B, A's K-1", w.accB.publicId, w.k1.A.id],
    ["as A, N's shared file through K", w.accA.publicId, w.nShared.id],
    ["as A, an unknown attachment", w.accA.publicId, "zz-no-such-file"],
  ] as const) {
    eq(
      `fileUrl ${label}: NOT_FOUND`,
      await codeOf(() =>
        u1.reports.fileUrl({ access, reportId: w.K, attachmentId }),
      ),
      "NOT_FOUND",
    );
  }
  eq(
    "fileUrl as F (other company) for A's K-1 of company 1: NOT_FOUND",
    await codeOf(() =>
      u1.reports.fileUrl({
        access: w.accF.publicId,
        reportId: w.K,
        attachmentId: w.k1.A.id,
      }),
    ),
    "NOT_FOUND",
  );
  eq(
    "no log row for any refused open",
    (await logRows({ portalUserId: w.U1.id, event: "REPORT_FILE_OPENED" }))
      .length,
    0,
  );

  const own = await u1.reports.fileUrl({
    access: w.accA.publicId,
    reportId: w.K,
    attachmentId: w.k1.A.id,
  });
  assertUrlOnly("A's own K-1", own);
  check(
    "the URL is signed for A's own object",
    own.url.includes(encodeURI(w.k1.A.key).replace(/^\//, "")) ||
      own.url.includes(w.k1.A.key.split("/").pop() ?? "??"),
  );
  const opened = await logRows({
    portalUserId: w.U1.id,
    event: "REPORT_FILE_OPENED",
  });
  eq("one REPORT_FILE_OPENED row", opened.length, 1);
  const row = opened[0];
  eq(
    "the row: memberReportAttachment / A's K-1 / A / A's access / company 1 / client address",
    [
      row?.targetType,
      row?.targetId,
      row?.stakeholderId,
      row?.portalAccessId,
      row?.companyId,
      row?.ip,
      row?.userAgent,
    ].join("|"),
    [
      "memberReportAttachment",
      w.k1.A.id,
      w.A.id,
      w.accA.id,
      w.c1.id,
      FACTS.ip,
      FACTS.userAgent,
    ].join("|"),
  );

  section("4b. attachments on a notice");
  const nA = await keep(
    u1.reports.get({ access: w.accA.publicId, reportId: w.N }),
  );
  eq(
    "A sees the shared file and its own",
    nA.attachments.map((a) => `${a.name}:${a.private}`).join(","),
    "Shared letter.pdf:false,Letter for A.pdf:true",
  );
  check(
    "PDFs open inline",
    nA.attachments.every((a) => a.inline),
  );
  const nB = await keep(
    u1.reports.get({ access: w.accB.publicId, reportId: w.N }),
  );
  eq(
    "B sees only the shared file",
    nB.attachments.map((a) => a.name).join(","),
    "Shared letter.pdf",
  );
  eq(
    "fileUrl as B for A's private letter: NOT_FOUND",
    await codeOf(() =>
      u1.reports.fileUrl({
        access: w.accB.publicId,
        reportId: w.N,
        attachmentId: w.nPrivateA.id,
      }),
    ),
    "NOT_FOUND",
  );
  eq(
    "fileUrl with N's attachment through Q: NOT_FOUND",
    await codeOf(() =>
      u1.reports.fileUrl({
        access: w.accA.publicId,
        reportId: w.Q,
        attachmentId: w.nShared.id,
      }),
    ),
    "NOT_FOUND",
  );

  section("4c. a key outside the company's namespace is refused");
  const foreign = await testBucket(w.c2, "foreign");
  const nRow = await reportRow(w.c1.id, w.N);
  const planted = await db.memberReportAttachment.create({
    data: {
      reportId: nRow.id,
      companyId: w.c1.id,
      kind: "GENERAL",
      name: "planted.pdf",
      bucketId: foreign.id,
      stakeholderId: null,
    },
  });
  eq(
    "fileUrl for an attachment whose key is company 2's: NOT_FOUND",
    await codeOf(() =>
      u1.reports.fileUrl({
        access: w.accA.publicId,
        reportId: w.N,
        attachmentId: planted.id,
      }),
    ),
    "NOT_FOUND",
  );
  await db.memberReportAttachment.delete({ where: { id: planted.id } });
}

// ---------------------------------------------------------------------------
// 5. Export

async function cellsOf(
  base64: string,
): Promise<{ sheets: string[]; text: string }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, "base64") as never);
  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        parts.push(String(cell.text ?? ""));
      });
    });
  }
  const props = workbook as unknown as Record<string, unknown>;
  for (const k of ["title", "subject", "creator", "description", "keywords"]) {
    if (typeof props[k] === "string") parts.push(props[k] as string);
  }
  return {
    sheets: workbook.worksheets.map((s) => s.name),
    text: parts.join("\n"),
  };
}

async function exportXlsx() {
  section("5. export");
  const u1 = portalCaller(w.U1.session);
  const u2 = portalCaller(w.U2.session);
  const file = await keep(
    u1.reports.exportXlsx({ access: w.accA.publicId, reportId: w.Q }),
  );
  check(
    "a file name",
    typeof file.fileName === "string" && file.fileName.endsWith(".xlsx"),
  );
  const { sheets, text } = await cellsOf(file.base64);
  check(
    "the bytes parse as xlsx with sheets",
    sheets.length > 0,
    sheets.join(","),
  );
  check("it carries the frozen title", text.includes(w.frozenQTitle));
  check("not the live title", !text.includes("MUST NOT SHOW"));
  const forbidden = [
    w.A.name,
    w.B.name,
    w.C.name,
    w.A.email,
    w.B.email,
    w.C.email,
    w.A.id,
    w.B.id,
    w.C.id,
    "Notice to Members",
    "Old notice",
  ];
  eq(
    "no recipient name, email, holder id or other report in it",
    forbidden.filter((s) => text.includes(s)).join(","),
    "",
  );
  const exported = await logRows({
    portalUserId: w.U1.id,
    event: "REPORT_EXPORTED",
  });
  const qId = (await reportRow(w.c1.id, w.Q)).id;
  eq("one REPORT_EXPORTED row", exported.length, 1);
  eq(
    "the row: memberReport / Q / A",
    [
      exported[0]?.targetType,
      exported[0]?.targetId,
      exported[0]?.stakeholderId,
    ].join("|"),
    ["memberReport", qId, w.A.id].join("|"),
  );
  for (const [label, caller, access, id] of [
    ["TAX_K1", u1, w.accA.publicId, w.K],
    ["a notice", u1, w.accA.publicId, w.N],
    ["C (not a recipient of Q)", u2, w.accC.publicId, w.Q],
    ["F (other company)", u1, w.accF.publicId, w.Q],
    ["a report before the portal", u1, w.accA.publicId, w.L],
  ] as const) {
    eq(
      `export of ${label}: NOT_FOUND`,
      await codeOf(() => caller.reports.exportXlsx({ access, reportId: id })),
      "NOT_FOUND",
    );
  }
  eq(
    "no log row for a refused export",
    (await logRows({ portalUserId: w.U1.id, event: "REPORT_EXPORTED" }))
      .length +
      (await logRows({ portalUserId: w.U2.id, event: "REPORT_EXPORTED" }))
        .length,
    1,
  );
}

// ---------------------------------------------------------------------------
// 6. Views, Origin, the team `get`

async function viewsAndTeam() {
  section("6. markViewed, Origin, canRemove in the team get");
  const before = await team().get({ publicId: w.Q });
  const byHolder = (g: typeof before) =>
    new Map(g.recipients.map((r) => [r.stakeholderId, r]));
  // A has exported Q already (section 5): a portal row for Q exists.
  const b0 = byHolder(before);
  eq("A: canRemove false after the export", b0.get(w.A.id)?.canRemove, false);
  eq("B: canRemove true (nothing opened)", b0.get(w.B.id)?.canRemove, true);
  eq("B: no portal view yet", b0.get(w.B.id)?.portalFirstViewedAt, null);

  // A cross-site POST is refused before anything is read or written.
  const foreign = portalCaller(w.U1.session, {
    origin: "https://evil.example",
  });
  eq(
    "markViewed with a foreign Origin: FORBIDDEN",
    await codeOf(() =>
      foreign.reports.markViewed({ access: w.accB.publicId, reportId: w.Q }),
    ),
    "FORBIDDEN",
  );
  eq(
    "fileUrl with no Origin: FORBIDDEN",
    await codeOf(() =>
      portalCaller(w.U1.session, { origin: null }).reports.fileUrl({
        access: w.accA.publicId,
        reportId: w.K,
        attachmentId: w.k1.A.id,
      }),
    ),
    "FORBIDDEN",
  );
  eq(
    "nothing logged for B by the refused calls",
    (await logRows({ portalUserId: w.U1.id, event: "REPORT_VIEWED" })).length,
    0,
  );

  const u1 = portalCaller(w.U1.session);
  eq(
    "B views Q",
    (
      await keep(
        u1.reports.markViewed({ access: w.accB.publicId, reportId: w.Q }),
      )
    ).ok,
    true,
  );
  const viewed = await logRows({
    portalUserId: w.U1.id,
    event: "REPORT_VIEWED",
  });
  const qId = (await reportRow(w.c1.id, w.Q)).id;
  eq(
    "one REPORT_VIEWED row: memberReport / Q / B / B's access / client address",
    viewed
      .map((r) =>
        [
          r.targetType,
          r.targetId,
          r.stakeholderId,
          r.portalAccessId,
          r.ip,
        ].join("|"),
      )
      .join(";"),
    ["memberReport", qId, w.B.id, w.accB.id, FACTS.ip].join("|"),
  );
  const after = byHolder(await team().get({ publicId: w.Q }));
  eq("B: canRemove now false", after.get(w.B.id)?.canRemove, false);
  check(
    "B: portalFirstViewedAt set",
    after.get(w.B.id)?.portalFirstViewedAt != null,
  );
  const recipientB = await db.memberReportRecipient.findFirstOrThrow({
    where: { reportId: qId, stakeholderId: w.B.id },
  });
  eq(
    "the emailed link's view columns are untouched",
    [recipientB.firstViewedAt, recipientB.viewCount].join("|"),
    "|0",
  );

  // Opening a file of N flips canRemove on N for that holder only.
  const n0 = byHolder(await team().get({ publicId: w.N }));
  eq("N: C removable before", n0.get(w.C.id)?.canRemove, true);
  const u2 = portalCaller(w.U2.session);
  assertUrlOnly(
    "C opens N's shared file",
    await u2.reports.fileUrl({
      access: w.accC.publicId,
      reportId: w.N,
      attachmentId: w.nShared.id,
    }),
  );
  const n1 = byHolder(await team().get({ publicId: w.N }));
  eq("N: C not removable after a file open", n1.get(w.C.id)?.canRemove, false);
  eq("N: B still removable", n1.get(w.B.id)?.canRemove, true);
  eq(
    "N: C has no portal view (a file open is not a view)",
    n1.get(w.C.id)?.portalFirstViewedAt,
    null,
  );

  // The RSC caller (no Origin, x-trpc-source rsc) reads; it records 127.0.0.1,
  // which is why views are recorded by browser mutations only.
  const rsc = portalCaller(w.U1.session, { origin: null, rsc: true });
  eq(
    "the RSC caller can read the report",
    await codeOf(() =>
      rsc.reports.get({ access: w.accA.publicId, reportId: w.Q }),
    ),
    "OK",
  );
}

// ---------------------------------------------------------------------------
// 7. No storage key or bucket id in any response

function noKeys(): Promise<void> {
  section("7. no storage key or bucket id in any response");
  const keys = [
    w.k1.A.key,
    w.k1.B.key,
    w.k1.C.key,
    w.nShared.key,
    w.nPrivateA.key,
    ...[w.k1.A, w.k1.B, w.k1.C, w.nShared, w.nPrivateA].map((a) => a.bucketId),
  ];
  const json = JSON.stringify(responses, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  check(
    "responses were collected",
    responses.length > 20,
    String(responses.length),
  );
  eq(
    "no key or bucket id appears",
    keys.filter((k) => json.includes(k)).join(","),
    "",
  );
  check("no 'bucket' field", !/"bucket(Id)?"\s*:/.test(json));
  check("no 'key' field", !/"key"\s*:/.test(json));
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Cleanup of the rows the company cleanup cannot see

async function cleanupPortal() {
  section("cleanup: portal users, sessions, buckets");
  await db.portalAccessLog.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalSession.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalAccess.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalUser.deleteMany({ where: { id: { in: portalUserIds } } });
  await db.memberReportAttachment.deleteMany({
    where: { bucketId: { in: bucketIds } },
  });
  await db.bucket.deleteMany({ where: { id: { in: bucketIds } } });
  const left =
    (await db.portalUser.count({ where: { id: { in: portalUserIds } } })) +
    (await db.portalSession.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.bucket.count({ where: { id: { in: bucketIds } } }));
  eq("portal users, sessions and buckets removed", left, 0);
}

await runScenarios([
  ["setup", setup],
  ["visibility", visibility],
  ["unpublish", unpublishCycle],
  ["frozen content and findReport", frozenAndFind],
  ["K-1 privacy and attachments", k1Privacy],
  ["export", exportXlsx],
  ["views and the team get", viewsAndTeam],
  ["no keys", noKeys],
  ["portal cleanup", cleanupPortal],
]);
