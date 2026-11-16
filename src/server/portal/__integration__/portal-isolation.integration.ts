/**
 * End-to-end isolation of the investor portal with every package merged
 * (04-investor-portal.md G1–G6, P9–P16, P33, P36, section 7 S1–S4, S10,
 * S14, S19, S22, S25–S28; package P11). Not part of `vitest run`. Run from
 * the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-isolation.integration.ts
 *
 * Companies are named `zz-portal-iso-…`, addresses `@example.com`. No email
 * is sent (account emails are captured, every release is portal-only) and
 * pg-boss is not started. Every row created is deleted at the end.
 *
 * Fixture. Company 1: A, B (Preferred Members), C (Common Member), D
 * (prospect), E (Financial Interest only). Company 2: F (Preferred Member).
 * People: U1 → A and F (two holders, two companies); U2 → B; U3 → A (an
 * accountant: a second person on A); U4 → C, DISABLED. Reports of company 1:
 * Q1 (to A and B), Q2 (to A only), N (notice to A, B, C: one shared file,
 * one private to A, one private to B), NB (notice to B only), K (TAX_K1 to A
 * and B, K-1 files for A and B), L (sent before the portal, to A), D (a draft
 * with a stray recipient row for A), NR (notice to A and B, A removed again
 * before anyone opened it). Company 2: QF (Q1 to F), X (notice to F with a
 * stray recipient row for A). Documents of company 1: AB (shared with A and
 * B), BO (B only), W9A (tied to A, shared with A, plus a hand-inserted grant
 * for B), NONE (shared with nobody); company 2: FD (shared with F, plus a
 * stray grant naming A's holder id).
 *
 * The procedure list is read from `portalRouter` and the route handlers from
 * the `route.ts` files under src/app/(portal): a procedure or handler with no
 * row in the coverage tables below fails the run.
 *
 * Refusals are compared as { code, message } with the answer for an id that
 * does not exist. Nothing is timed: the comparison is of the answers only.
 * Pages (home, go-page, print) are Server Components on these procedures;
 * the browser pass covers them as pages.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { POST as setPasswordPOST } from "@/app/(portal)/portal/auth/set-password/route";
import { POST as signInPOST } from "@/app/(portal)/portal/auth/sign-in/route";
import { POST as signOutPOST } from "@/app/(portal)/portal/auth/sign-out/route";
import { generatePublicId } from "@/common/id";
import { reportFileJob } from "@/jobs/governance-report-file";
import {
  deliverPortalAccountEmail,
  type PortalAccountEmailDeps,
} from "@/jobs/portal-account-email";
import { fromDateOnly } from "@/lib/date-only";
import { monthsBetween } from "@/lib/llc/financial-periods";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
import {
  actor,
  check,
  createAdmin,
  createCompany,
  db,
  errorOf,
  inTx,
  issueCommon,
  newMember,
  runScenarios,
  section,
  setCompanyPrefix,
  setToday,
  type TestCompany,
  usd,
} from "@/server/llc/__integration__/harness";
import {
  createCommitment,
  decideCommitment,
  recordCapitalReceipt,
} from "@/server/llc/commitments";
import { SIGN_IN_REFUSED_MESSAGE } from "@/server/portal/account";
import {
  type PortalAccountEmailData,
  portalAccountEmailJob,
} from "@/server/portal/account-email";
import { createPortalSession, portalCookieName } from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import { financialDashboardRouter } from "@/trpc/routers/financial-dashboard-router/router";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { portalAdminRouter } from "@/trpc/routers/portal-admin-router/router";
import { portalAuthRouter } from "@/trpc/routers/portal-auth-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";

setCompanyPrefix("zz-portal-iso-");
const EMAIL_PREFIX = "zz-portal-iso.";
const BASE = "http://localhost:3000";
const FACTS = { ip: "203.0.113.77", userAgent: "portal-isolation-integration" };
const TODAY = "2026-10-05";
const JAN_SEP = monthsBetween("2026-01-01", "2026-09-01");
const PASSWORD = "Isolation-Pass-Phrase-2026";
const NEW_PASSWORD = "Isolation-Pass-Phrase-2027";

const show = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    isDeepStrictEqual(actual, expected),
    `got ${show(actual)}, expected ${show(expected)}`,
  );
}

// pg-boss is not started: the filing job is dropped, account emails captured.
(reportFileJob as { emit: unknown }).emit = () => Promise.resolve();
const accountJobs: PortalAccountEmailData[] = [];
(portalAccountEmailJob as { emit: unknown }).emit = (
  data: PortalAccountEmailData,
) => {
  accountJobs.push(data);
  return Promise.resolve(null);
};
const mails: { to: string; html: string }[] = [];
const capture: PortalAccountEmailDeps = {
  send: ((options: { to: unknown; html: unknown }) => {
    mails.push({ to: String(options.to), html: String(options.html) });
    return Promise.resolve({
      emailLogId: null,
      sentAt: new Date(),
      messageId: null,
    });
  }) as PortalAccountEmailDeps["send"],
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Bookkeeping

const portalUserIds: string[] = [];
const bucketIds: string[] = [];

interface Holder {
  id: string;
  name: string;
  email: string;
}
interface Person {
  id: string;
  email: string;
  session: string;
  /** stakeholder id → access public id */
  access: Map<string, string>;
  /** stakeholder id → PortalAccess.id */
  accessRowId: Map<string, string>;
}

/** Every successful portal answer, by the person who received it. */
const answers = new Map<string, unknown[]>();
function keep<T>(person: Person, value: T): T {
  const list = answers.get(person.id) ?? [];
  list.push(value);
  answers.set(person.id, list);
  return value;
}

// ---------------------------------------------------------------------------
// Callers

function portalCaller(
  sessionToken: string | null,
  opts: {
    origin?: string | null;
    teamSession?: Session | null;
    cookie?: string;
  } = {},
) {
  const headers = new Headers();
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  else if (sessionToken !== null)
    headers.set("cookie", `${portalCookieName()}=${sessionToken}`);
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  return createCallerFactory(portalRouter)({
    db,
    session: opts.teamSession ?? null,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers,
  } as never);
}
type PortalCaller = ReturnType<typeof portalCaller>;

interface Answer {
  code: string;
  message: string;
}
/** `{ code, message }` of a refusal, or OK. */
async function answerOf(fn: () => Promise<unknown>): Promise<Answer> {
  const error = (await errorOf(fn)) as {
    code?: string;
    message?: string;
  } | null;
  if (error === null) return { code: "OK", message: "" };
  return { code: error.code ?? "THROWN", message: error.message ?? "" };
}

function post(
  path: string,
  opts: { body?: unknown; origin?: string | null; cookie?: string } = {},
) {
  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": FACTS.userAgent,
    "x-forwarded-for": FACTS.ip,
  });
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function sessionFrom(response: Response): string | null {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, value] = (pair ?? "").split("=");
    if (name === portalCookieName() && value) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixture helpers

async function subscribeOn(
  c: TestCompany,
  stakeholderId: string,
  cents: bigint,
  on: string,
) {
  setToday(on);
  await inTx(async (tx) => {
    const commitment = await createCommitment(
      tx,
      {
        companyId: c.id,
        stakeholderId,
        unitClassId: c.preferredId,
        committedCents: cents,
        signedOn: on,
      },
      actor,
    );
    await recordCapitalReceipt(
      tx,
      {
        companyId: c.id,
        commitmentId: commitment.id,
        receivedOn: on,
        amountCents: cents,
      },
      actor,
    );
    await decideCommitment(
      tx,
      {
        companyId: c.id,
        commitmentId: commitment.id,
        decision: "ACCEPT",
        acceptedOn: on,
      },
      actor,
    );
  });
}

async function revenue(c: TestCompany, month: string, receipts: bigint) {
  await db.revenuePeriod.create({
    data: {
      companyId: c.id,
      month: fromDateOnly(month),
      customerReceiptsCents: receipts,
      passThroughFeesCents: 0n,
      otherIncomeCents: 0n,
      utilizationBps: 8_000,
      managementFeeBps: 500,
      managementFeeCents: (receipts * 500n) / 10_000n,
      updatedById: "portal-isolation-integration",
    },
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

type Reports = ReturnType<typeof reportsCaller>;
const reportsCaller = (
  ctx: Awaited<ReturnType<typeof createAdmin>>["context"],
) => createCallerFactory(memberReportRouter)(ctx);

async function quarterDraft(reports: Reports, c: TestCompany, quarter: 1 | 2) {
  const { publicId } = await reports.create({
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: quarter,
  });
  const row = await db.memberReport.findFirstOrThrow({
    where: { publicId, companyId: c.id },
  });
  // biome-ignore lint/suspicious/noExplicitAny: test fixture edits JSON
  const figures = JSON.parse(JSON.stringify(row.figures)) as any;
  figures.utilization.bps = 8_000;
  figures.managerPayments.confirmedNone = true;
  await reports.update({
    publicId,
    title: `Q${quarter} 2026 report`,
    figures,
    commentary: [paragraph("Quarter in review.")],
  });
  return publicId;
}

async function noticeDraft(reports: Reports, title: string) {
  const { publicId } = await reports.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await reports.update({
    publicId,
    title,
    figures: {},
    commentary: [paragraph(`${title}: body.`)],
  });
  return publicId;
}

async function bucket(c: TestCompany, label: string) {
  const row = await db.bucket.create({
    data: {
      name: `${label}.pdf`,
      key: `${c.name}/generic-documents-zz-iso-${label}-${randomUUID().slice(0, 8)}.pdf`,
      mimeType: "application/pdf",
      size: 1234,
      tags: ["generic"],
    },
  });
  bucketIds.push(row.id);
  return row;
}

async function attach(
  c: TestCompany,
  reportPublicId: string,
  label: string,
  stakeholderId: string | null,
  kind: "K1" | "GENERAL",
) {
  const report = await db.memberReport.findFirstOrThrow({
    where: { publicId: reportPublicId, companyId: c.id },
  });
  const b = await bucket(c, label);
  const row = await db.memberReportAttachment.create({
    data: {
      reportId: report.id,
      companyId: c.id,
      kind,
      name: `${label}.pdf`,
      bucketId: b.id,
      stakeholderId,
    },
  });
  return { id: row.id, key: b.key, bucketId: b.id };
}

async function documentRow(
  c: TestCompany,
  label: string,
  extra: { stakeholderId?: string; kind?: string } = {},
) {
  const b = await bucket(c, label);
  const row = await db.document.create({
    data: {
      companyId: c.id,
      publicId: generatePublicId(),
      name: `${label}.pdf`,
      bucketId: b.id,
      stakeholderId: extra.stakeholderId ?? null,
      kind: extra.kind ?? null,
    },
  });
  return { id: row.id, publicId: row.publicId, key: b.key, bucketId: b.id };
}

function handRecipient(reportPublicId: string, c: TestCompany, holder: Holder) {
  return db.memberReport
    .findFirstOrThrow({ where: { publicId: reportPublicId, companyId: c.id } })
    .then((r) =>
      db.memberReportRecipient.create({
        data: {
          reportId: r.id,
          companyId: c.id,
          stakeholderId: holder.id,
          name: holder.name,
          email: holder.email,
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    );
}

async function person(
  label: string,
  holders: { companyId: string; stakeholderId: string; disabled?: boolean }[],
): Promise<Person> {
  const email = `${EMAIL_PREFIX}${label}.${randomUUID().slice(0, 8)}@example.com`;
  const user = await db.portalUser.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      passwordSetAt: new Date(),
    },
  });
  portalUserIds.push(user.id);
  const access = new Map<string, string>();
  const accessRowId = new Map<string, string>();
  for (const h of holders) {
    const row = await db.portalAccess.create({
      data: {
        publicId: `pa_${randomUUID().replace(/-/g, "")}`,
        portalUserId: user.id,
        companyId: h.companyId,
        stakeholderId: h.stakeholderId,
        status: h.disabled ? "DISABLED" : "ACTIVE",
        disabledAt: h.disabled ? new Date() : null,
        invitedById: "portal-isolation-integration",
      },
    });
    access.set(h.stakeholderId, row.publicId);
    accessRowId.set(h.stakeholderId, row.id);
  }
  return {
    id: user.id,
    email,
    session: await newSession(user.id),
    access,
    accessRowId,
  };
}

async function newSession(portalUserId: string): Promise<string> {
  const { token } = await createPortalSession(db, {
    portalUserId,
    ip: FACTS.ip,
    userAgent: FACTS.userAgent,
    now: new Date(),
  });
  return token;
}

function accessOf(p: Person, h: Holder): string {
  const id = p.access.get(h.id);
  if (id === undefined) throw new Error(`no access for ${h.name}`);
  return id;
}

// ---------------------------------------------------------------------------
// World

interface World {
  c1: TestCompany;
  c2: TestCompany;
  A: Holder;
  B: Holder;
  C: Holder;
  D: Holder;
  E: Holder;
  F: Holder;
  admin1: Awaited<ReturnType<typeof createAdmin>>["context"];
  admin2: Awaited<ReturnType<typeof createAdmin>>["context"];
  reports1: Reports;
  reports2: Reports;
  U1: Person;
  U2: Person;
  U3: Person;
  U4: Person;
  rep: Record<
    "Q1" | "Q2" | "N" | "NB" | "K" | "L" | "D" | "NR" | "QF" | "X",
    string
  >;
  att: Record<
    "nShared" | "nA" | "nB" | "nbFile" | "kA" | "kB" | "xFile",
    { id: string; key: string; bucketId: string }
  >;
  doc: Record<
    "AB" | "BO" | "W9A" | "NONE" | "FD",
    { id: string; publicId: string; key: string; bucketId: string }
  >;
  teamSession: Session;
}
let w: World;

async function setup() {
  section("setup");
  const c1 = await createCompany("one");
  const c2 = await createCompany("two");
  const A = await newMember(c1, "Alderwyn Quillfeather");
  const B = await newMember(c1, "Birchmont Vantorell");
  const C = await newMember(c1, "Cedarline Mossgrove");
  const D = await newMember(c1, "Dunmore Prospectley");
  const E = await newMember(c1, "Elmsworth Interestine");
  const F = await newMember(c2, "Fircrest Haldaneth");
  await issueCommon(c1, C.id, "100", "2026-01-05");
  await subscribeOn(c1, A.id, usd(100_000), "2026-01-12");
  await subscribeOn(c1, B.id, usd(250_000), "2026-02-10");
  await subscribeOn(c1, E.id, usd(50_000), "2026-02-11");
  await subscribeOn(c2, F.id, usd(80_000), "2026-01-20");
  for (const [i, m] of JAN_SEP.entries()) {
    await revenue(c1, m, usd(20_000 + 1_000 * i));
    await revenue(c2, m, usd(5_000));
  }
  setToday(TODAY);
  await db.stakeholder.update({
    where: { id: D.id },
    data: { memberStatus: "PROSPECT" },
  });
  await db.stakeholder.update({
    where: { id: E.id },
    data: { memberStatus: "FINANCIAL_INTEREST_ONLY" },
  });
  const admin1 = (await createAdmin(c1)).context;
  const admin2 = (await createAdmin(c2)).context;
  const reports1 = reportsCaller(admin1);
  const reports2 = reportsCaller(admin2);
  const release = (r: Reports, publicId: string, ids: string[]) =>
    r.release({ publicId, stakeholderIds: ids, email: false });

  const Q1 = await quarterDraft(reports1, c1, 1);
  await release(reports1, Q1, [A.id, B.id]);
  const Q2 = await quarterDraft(reports1, c1, 2);
  await release(reports1, Q2, [A.id]);
  const QF = await quarterDraft(reports2, c2, 1);
  await release(reports2, QF, [F.id]);

  const N = await noticeDraft(reports1, "Notice to all holders");
  const nShared = await attach(c1, N, "n-shared", null, "GENERAL");
  const nA = await attach(c1, N, "n-private-a", A.id, "GENERAL");
  const nB = await attach(c1, N, "n-private-b", B.id, "GENERAL");
  await release(reports1, N, [A.id, B.id, C.id]);
  const NB = await noticeDraft(reports1, "Notice for B only");
  const nbFile = await attach(c1, NB, "nb-file", null, "GENERAL");
  await release(reports1, NB, [B.id]);

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
  const kA = await attach(c1, K, "k1-a", A.id, "K1");
  const kB = await attach(c1, K, "k1-b", B.id, "K1");
  await release(reports1, K, [A.id, B.id]);

  const lRow = await db.memberReport.create({
    data: {
      publicId: `zz-portal-iso-${randomUUID().slice(0, 12)}`,
      companyId: c1.id,
      type: "NOTICE",
      status: "SENT",
      noticeKind: "GENERAL",
      title: "Before the portal",
      commentary: [],
      figures: {},
      frozenContent: { title: "Before the portal", doc: [] },
      frozenHash: "x",
      sentAt: new Date(),
      authorId: "portal-isolation-integration",
    },
  });
  await handRecipient(lRow.publicId, c1, A);
  const Dr = await noticeDraft(reports1, "Draft notice");
  await handRecipient(Dr, c1, A);
  const NR = await noticeDraft(reports1, "Notice A is removed from");
  await release(reports1, NR, [A.id, B.id]);
  const nrA = await db.memberReportRecipient.findFirstOrThrow({
    where: { companyId: c1.id, stakeholderId: A.id, report: { publicId: NR } },
  });
  await reports1.removeRecipient({ publicId: NR, recipientId: nrA.id });

  const X = await noticeDraft(reports2, "Company two notice");
  const xFile = await attach(c2, X, "x-file", null, "GENERAL");
  await release(reports2, X, [F.id]);
  await handRecipient(X, c2, A);

  // Documents.
  const AB = await documentRow(c1, "doc-ab");
  const BO = await documentRow(c1, "doc-b-only");
  const W9A = await documentRow(c1, "w9-a", {
    stakeholderId: A.id,
    kind: "w9",
  });
  const NONE = await documentRow(c1, "doc-none");
  const FD = await documentRow(c2, "doc-f");
  const share1 = createCallerFactory(portalAdminRouter)(admin1);
  const share2 = createCallerFactory(portalAdminRouter)(admin2);
  await share1.shareDocuments({
    documentPublicIds: [AB.publicId],
    stakeholderIds: [A.id, B.id],
  });
  await share1.shareDocuments({
    documentPublicIds: [BO.publicId],
    stakeholderIds: [B.id],
  });
  await share1.shareDocuments({
    documentPublicIds: [W9A.publicId],
    stakeholderIds: [A.id],
  });
  await share2.shareDocuments({
    documentPublicIds: [FD.publicId],
    stakeholderIds: [F.id],
  });
  // Second line of defence: rows the share procedure would refuse.
  await db.portalDocumentGrant.create({
    data: {
      companyId: c1.id,
      documentId: W9A.id,
      stakeholderId: B.id,
      grantedById: "portal-isolation-integration",
    },
  });
  await db.portalDocumentGrant.create({
    data: {
      companyId: c2.id,
      documentId: FD.id,
      stakeholderId: A.id,
      grantedById: "portal-isolation-integration",
    },
  });

  const U1 = await person("u1", [
    { companyId: c1.id, stakeholderId: A.id },
    { companyId: c2.id, stakeholderId: F.id },
  ]);
  const U2 = await person("u2", [{ companyId: c1.id, stakeholderId: B.id }]);
  const U3 = await person("u3-accountant", [
    { companyId: c1.id, stakeholderId: A.id },
  ]);
  const U4 = await person("u4", [
    { companyId: c1.id, stakeholderId: C.id, disabled: true },
  ]);

  const teamSession = (admin1 as unknown as { session: Session }).session;
  w = {
    c1,
    c2,
    A,
    B,
    C,
    D,
    E,
    F,
    admin1,
    admin2,
    reports1,
    reports2,
    U1,
    U2,
    U3,
    U4,
    rep: { Q1, Q2, N, NB, K, L: lRow.publicId, D: Dr, NR, QF, X },
    att: { nShared, nA, nB, nbFile, kA, kB, xFile },
    doc: { AB, BO, W9A, NONE, FD },
    teamSession,
  };
  check("fixtures created", true);
}

// ---------------------------------------------------------------------------
// The procedure catalogue

type Kind = "session" | "investor";
interface Row {
  kind: Kind;
  mutation: boolean;
  /** A call that succeeds for U1 acting for A (the access is ignored by session procedures). */
  call: (p: PortalCaller, access: string) => Promise<unknown>;
}

function catalogue(): Record<string, Row> {
  const finView = {
    view: "fund" as const,
    grain: "quarter" as const,
    from: "2026-01-01",
    to: "2026-09-01",
  };
  return {
    me: { kind: "session", mutation: false, call: (p) => p.me() },
    changePassword: {
      kind: "session",
      mutation: true,
      // a wrong current password: refused for the session that is valid,
      // which is enough to see the session and Origin rules apply
      call: (p) =>
        p.changePassword({
          currentPassword: "wrong-wrong-wrong",
          newPassword: NEW_PASSWORD,
        }),
    },
    findReport: {
      kind: "session",
      mutation: false,
      call: (p) => p.findReport({ reportId: w.rep.Q1 }),
    },
    home: {
      kind: "investor",
      mutation: false,
      call: (p, a) => p.home({ access: a }),
    },
    "reports.list": {
      kind: "investor",
      mutation: false,
      call: (p, a) => p.reports.list({ access: a }),
    },
    "reports.get": {
      kind: "investor",
      mutation: false,
      call: (p, a) => p.reports.get({ access: a, reportId: w.rep.N }),
    },
    "reports.markViewed": {
      kind: "investor",
      mutation: true,
      call: (p, a) => p.reports.markViewed({ access: a, reportId: w.rep.N }),
    },
    "reports.fileUrl": {
      kind: "investor",
      mutation: true,
      call: (p, a) =>
        p.reports.fileUrl({
          access: a,
          reportId: w.rep.N,
          attachmentId: w.att.nShared.id,
        }),
    },
    "reports.exportXlsx": {
      kind: "investor",
      mutation: true,
      call: (p, a) => p.reports.exportXlsx({ access: a, reportId: w.rep.Q1 }),
    },
    "documents.list": {
      kind: "investor",
      mutation: false,
      call: (p, a) => p.documents.list({ access: a }),
    },
    "documents.fileUrl": {
      kind: "investor",
      mutation: true,
      call: (p, a) =>
        p.documents.fileUrl({ access: a, documentId: w.doc.AB.publicId }),
    },
    "financials.get": {
      kind: "investor",
      mutation: false,
      call: (p, a) => p.financials.get({ access: a }),
    },
    "financials.exportXlsx": {
      kind: "investor",
      mutation: true,
      call: (p, a) => p.financials.exportXlsx({ access: a, ...finView }),
    },
  };
}

/** The `route.ts` files under the portal route group, as URL paths. */
function portalRouteHandlers(): string[] {
  const root = join(process.cwd(), "src/app/(portal)");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry === "route.ts")
        out.push(
          `/${relative(root, p)
            .split("/")
            .filter((s) => !s.startsWith("("))
            .slice(0, -1)
            .join("/")}`,
        );
    }
  };
  walk(root);
  return out.sort();
}
const ROUTE_COVERAGE = [
  "/portal/auth/set-password",
  "/portal/auth/sign-in",
  "/portal/auth/sign-out",
];

async function coverage() {
  section("0. coverage: every portal procedure and route handler has a row");
  const paths = Object.keys(
    (
      portalRouter as unknown as {
        _def: { procedures: Record<string, unknown> };
      }
    )._def.procedures,
  ).sort();
  const rows = catalogue();
  check(
    "the router lists at least 13 procedures",
    paths.length >= 13,
    paths.join(","),
  );
  eq(
    "every procedure has a coverage row (and no stale row)",
    Object.keys(rows).sort(),
    paths,
  );
  eq(
    "route handlers under src/app/(portal)",
    portalRouteHandlers(),
    ROUTE_COVERAGE,
  );
  for (const [path, row] of Object.entries(rows)) {
    // File URLs carry their own storage key by design: scanned in section 8.
    const scanned = !path.endsWith(".fileUrl");
    const out = await answerOf(async () => {
      const value = await row.call(
        portalCaller(w.U1.session),
        accessOf(w.U1, w.A),
      );
      if (scanned) keep(w.U1, value);
    });
    // changePassword is refused by design (wrong current password)
    const expected = path === "changePassword" ? "BAD_REQUEST" : "OK";
    eq(
      `${path}: the reference call (U1 as A) answers ${expected}`,
      out.code,
      expected,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Sessions: every procedure refuses without a valid portal session

async function sessions() {
  section(
    "1. no portal session: every procedure, the same UNAUTHORIZED (G1, S2)",
  );
  const rows = catalogue();
  const access = accessOf(w.U1, w.A);
  // Session rows made unusable in each way the rules name.
  const expired = await newSession(w.U1.id);
  await db.portalSession.update({
    where: {
      tokenHash: (await import("@/lib/portal/token-core")).hashToken(expired),
    },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  const idle = await newSession(w.U1.id);
  await db.portalSession.update({
    where: {
      tokenHash: (await import("@/lib/portal/token-core")).hashToken(idle),
    },
    data: { lastSeenAt: new Date(Date.now() - 24 * 3_600_000 - 1_000) },
  });
  const revoked = await newSession(w.U1.id);
  await db.portalSession.update({
    where: {
      tokenHash: (await import("@/lib/portal/token-core")).hashToken(revoked),
    },
    data: { revokedAt: new Date() },
  });
  const signedOut = await newSession(w.U1.id);
  const out = await signOutPOST(
    post("/portal/auth/sign-out", {
      cookie: `${portalCookieName()}=${signedOut}`,
    }),
  );
  check(
    "sign-out answers (303 to the sign-in page)",
    out.status === 303 || (out.status >= 200 && out.status < 300),
    String(out.status),
  );

  const variants: [string, PortalCaller][] = [
    ["no cookie", portalCaller(null)],
    ["only a team session", portalCaller(null, { teamSession: w.teamSession })],
    [
      "a cookie that is no session",
      portalCaller(null, { cookie: `${portalCookieName()}=${"x".repeat(43)}` }),
    ],
    ["an expired session (7 days)", portalCaller(expired)],
    ["an idle session (24 h)", portalCaller(idle)],
    ["a revoked session", portalCaller(revoked)],
    ["a signed-out session", portalCaller(signedOut)],
    [
      "the team session beside an expired portal cookie",
      portalCaller(expired, { teamSession: w.teamSession }),
    ],
  ];
  let baseline: Answer | null = null;
  for (const [path, row] of Object.entries(rows)) {
    for (const [label, caller] of variants) {
      const a = await answerOf(() => row.call(caller, access));
      baseline ??= a;
      eq(`${path}, ${label}: UNAUTHORIZED, the one answer`, a, baseline);
    }
  }
  eq("that one answer is UNAUTHORIZED", baseline?.code, "UNAUTHORIZED");

  section("1b. a mutation without the app's Origin is FORBIDDEN (S17)");
  for (const [path, row] of Object.entries(rows)) {
    if (!row.mutation) continue;
    for (const origin of [
      null,
      "null",
      "https://evil.example",
      "http://localhost:3001",
    ]) {
      const a = await answerOf(() =>
        row.call(portalCaller(w.U1.session, { origin }), access),
      );
      eq(
        `${path} with Origin ${origin ?? "(none)"}: FORBIDDEN`,
        a.code,
        "FORBIDDEN",
      );
    }
  }

  section("1c. a portal session reaches no team procedure (T-ISO-1, S1)");
  const ctx = {
    db,
    session: null,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers: new Headers({
      cookie: `${portalCookieName()}=${w.U1.session}`,
      origin: BASE,
    }),
  } as never;
  for (const [label, fn] of [
    [
      "memberReport.list",
      () => createCallerFactory(memberReportRouter)(ctx).list({}),
    ],
    [
      "portalAdmin.overview",
      () => createCallerFactory(portalAdminRouter)(ctx).overview(),
    ],
    [
      "financialDashboard.live",
      () => createCallerFactory(financialDashboardRouter)(ctx).live({}),
    ],
  ] as const) {
    eq(
      `${label} with only a portal session: UNAUTHORIZED`,
      (await answerOf(fn)).code,
      "UNAUTHORIZED",
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Accesses: another person's, another company's, disabled, unknown

async function accesses() {
  section(
    "2. an access that is not the caller's: the same NOT_FOUND as an unknown id (P10, S3)",
  );
  const rows = catalogue();
  const unknownAccess = `pa_${"0".repeat(32)}`;
  const u1 = portalCaller(w.U1.session);
  const u4 = portalCaller(w.U4.session);
  const logBefore = await db.portalAccessLog.count({
    where: { portalUserId: { in: portalUserIds } },
  });
  for (const [path, row] of Object.entries(rows)) {
    if (row.kind !== "investor") continue;
    const unknown = await answerOf(() => row.call(u1, unknownAccess));
    eq(`${path}: an unknown access id is NOT_FOUND`, unknown.code, "NOT_FOUND");
    for (const [label, caller, access] of [
      ["U1 with U2's access to B (same company)", u1, accessOf(w.U2, w.B)],
      [
        "U1 with U3's access to A (another person, same holder)",
        u1,
        accessOf(w.U3, w.A),
      ],
      ["U1 with U4's disabled access to C", u1, accessOf(w.U4, w.C)],
      ["U4 with its own disabled access", u4, accessOf(w.U4, w.C)],
      [
        "U2 with U1's access to F (another company)",
        portalCaller(w.U2.session),
        accessOf(w.U1, w.F),
      ],
      ["U1 with a stakeholder id as the access", u1, w.A.id],
    ] as const) {
      eq(
        `${path}, ${label}: as unknown`,
        await answerOf(() => row.call(caller, access)),
        unknown,
      );
    }
  }
  eq(
    "refused calls wrote no access-log row (T-LOG)",
    await db.portalAccessLog.count({
      where: { portalUserId: { in: portalUserIds } },
    }),
    logBefore,
  );
}

// ---------------------------------------------------------------------------
// 3. Items: other holders', other companies', unpublished, drafts, unknown

async function items() {
  section(
    "3. an item the holder may not see: the same NOT_FOUND as an unknown id (P11–P14, S3, S4)",
  );
  const u1 = portalCaller(w.U1.session);
  const a = accessOf(w.U1, w.A);
  const logBefore = await db.portalAccessLog.count({
    where: { portalUserId: { in: portalUserIds } },
  });
  const unknownReport = "zz-iso-no-such-report";
  const reportCalls = {
    "reports.get": (id: string) => u1.reports.get({ access: a, reportId: id }),
    "reports.markViewed": (id: string) =>
      u1.reports.markViewed({ access: a, reportId: id }),
    "reports.exportXlsx": (id: string) =>
      u1.reports.exportXlsx({ access: a, reportId: id }),
  };
  for (const [path, call] of Object.entries(reportCalls)) {
    const unknown = await answerOf(() => call(unknownReport));
    eq(`${path}: an unknown report is NOT_FOUND`, unknown.code, "NOT_FOUND");
    const cases: [string, string][] = [
      ["NB (released to B only)", w.rep.NB],
      ["NR (A removed from the audience)", w.rep.NR],
      ["L (sent before the portal)", w.rep.L],
      ["D (a draft with a recipient row for A)", w.rep.D],
      ["X (company 2, with a stray row for A)", w.rep.X],
      ["QF (company 2's quarterly)", w.rep.QF],
    ];
    if (path === "reports.exportXlsx")
      cases.push(
        ["K (TAX_K1: never exportable)", w.rep.K],
        ["N (a notice)", w.rep.N],
      );
    for (const [label, id] of cases)
      eq(
        `${path}, ${label}: as unknown`,
        await answerOf(() => call(id)),
        unknown,
      );
  }

  const file = (reportId: string, attachmentId: string) =>
    answerOf(() => u1.reports.fileUrl({ access: a, reportId, attachmentId }));
  const unknownFile = await file(w.rep.N, "zz-iso-no-such-attachment");
  eq(
    "reports.fileUrl: an unknown attachment is NOT_FOUND",
    unknownFile.code,
    "NOT_FOUND",
  );
  for (const [label, reportId, attachmentId] of [
    ["N with B's private file", w.rep.N, w.att.nB.id],
    ["K with B's K-1", w.rep.K, w.att.kB.id],
    [
      "N with NB's file (attachment of another report)",
      w.rep.N,
      w.att.nbFile.id,
    ],
    ["NB with its own file (A not a recipient)", w.rep.NB, w.att.nbFile.id],
    ["X with its file (other company)", w.rep.X, w.att.xFile.id],
    ["an unknown report with A's own file", unknownReport, w.att.nA.id],
  ] as const) {
    eq(
      `reports.fileUrl, ${label}: as unknown`,
      await file(reportId, attachmentId),
      unknownFile,
    );
  }

  const doc = (caller: PortalCaller, access: string, documentId: string) =>
    answerOf(() => caller.documents.fileUrl({ access, documentId }));
  const unknownDoc = await doc(u1, a, "zz-iso-no-such-document");
  eq(
    "documents.fileUrl: an unknown document is NOT_FOUND",
    unknownDoc.code,
    "NOT_FOUND",
  );
  const u2 = portalCaller(w.U2.session);
  const b = accessOf(w.U2, w.B);
  for (const [label, caller, access, id] of [
    ["A: BO (shared with B only)", u1, a, w.doc.BO.publicId],
    ["A: NONE (shared with nobody)", u1, a, w.doc.NONE.publicId],
    ["A: FD (company 2, a stray grant naming A)", u1, a, w.doc.FD.publicId],
    ["F: AB (company 1)", u1, accessOf(w.U1, w.F), w.doc.AB.publicId],
    [
      "B: W9A (tied to A; a hand-inserted grant for B, P14)",
      u2,
      b,
      w.doc.W9A.publicId,
    ],
  ] as const) {
    eq(
      `documents.fileUrl, ${label}: as unknown`,
      await doc(caller, access, id),
      unknownDoc,
    );
  }

  section(
    "3b. lists, home, dashboard and findReport show exactly the holder's items",
  );
  const ids = async (access: string, caller = u1) =>
    (await caller.reports.list({ access })).map((r) => keep(w.U1, r).id).sort();
  eq(
    "A's reports: Q1, Q2, N, K",
    await ids(a),
    [w.rep.Q1, w.rep.Q2, w.rep.N, w.rep.K].sort(),
  );
  eq(
    "B's reports (U2): Q1, N, NB, K, NR",
    (await u2.reports.list({ access: b })).map((r) => keep(w.U2, r).id).sort(),
    [w.rep.Q1, w.rep.N, w.rep.NB, w.rep.K, w.rep.NR].sort(),
  );
  eq(
    "F's reports (U1): QF, X",
    await ids(accessOf(w.U1, w.F)),
    [w.rep.QF, w.rep.X].sort(),
  );
  const aDocs = (await u1.documents.list({ access: a }))
    .map((d) => keep(w.U1, d).id)
    .sort();
  eq(
    "A's documents: AB, W9A",
    aDocs,
    [w.doc.AB.publicId, w.doc.W9A.publicId].sort(),
  );
  const bDocs = (await u2.documents.list({ access: b }))
    .map((d) => keep(w.U2, d).id)
    .sort();
  eq(
    "B's documents: AB, BO (not W9A)",
    bDocs,
    [w.doc.AB.publicId, w.doc.BO.publicId].sort(),
  );
  const fDocs = (await u1.documents.list({ access: accessOf(w.U1, w.F) })).map(
    (d) => d.id,
  );
  eq("F's documents: FD", fDocs, [w.doc.FD.publicId]);

  const kGet = keep(
    w.U1,
    await u1.reports.get({ access: a, reportId: w.rep.K }),
  );
  eq(
    "on K, A sees only A's K-1",
    kGet.attachments.map((x) => x.id),
    [w.att.kA.id],
  );
  const nGet = keep(
    w.U1,
    await u1.reports.get({ access: a, reportId: w.rep.N }),
  );
  eq(
    "on N, A sees the shared file and A's own (not B's)",
    nGet.attachments.map((x) => x.id).sort(),
    [w.att.nShared.id, w.att.nA.id].sort(),
  );

  const finA = keep(w.U1, await u1.financials.get({ access: a }));
  const finB = keep(w.U2, await u2.financials.get({ access: b }));
  eq(
    "A is published through June (Q2 released to A)",
    finA.publishedThrough,
    "2026-06-30",
  );
  eq(
    "B is published through March (not selected for Q2)",
    finB.publishedThrough,
    "2026-03-31",
  );
  check(
    "A's fund months stop at June, B's at March",
    finA.fundMonths.every((m) => m.month <= "2026-06-01") &&
      finB.fundMonths.every((m) => m.month <= "2026-03-01") &&
      finB.fundMonths.length === 3,
  );
  const holderIdsSeen = JSON.stringify([finA.holderMonths, finB.holderMonths]);
  check(
    "no holder month names a stakeholder id (P36: holder rows leave as the holder's own, unnamed)",
    ![w.A.id, w.B.id, w.C.id, w.E.id].some((id) => holderIdsSeen.includes(id)),
  );
  eq(
    "B's holder months are two (Feb–Mar: B subscribed in February)",
    finB.holderMonths.length,
    2,
  );
  const homeA = keep(w.U1, await u1.home({ access: a }));
  check(
    "A's home: the latest report is one of A's and the documents are A's",
    [w.rep.Q1, w.rep.Q2, w.rep.N, w.rep.K].includes(
      homeA.latestReport?.id ?? "",
    ) && homeA.documents.every((d) => aDocs.includes(d.id)),
  );

  const find = async (caller: PortalCaller, reportId: string) =>
    (await caller.findReport({ reportId })).matches.map((m) => m.access).sort();
  eq("findReport NB for U1: no match", await find(u1, w.rep.NB), []);
  eq(
    "findReport X for U1: F only (not A's stray row)",
    await find(u1, w.rep.X),
    [accessOf(w.U1, w.F)],
  );
  eq("findReport Q1 for U1: A only", await find(u1, w.rep.Q1), [a]);
  eq("findReport D (draft) for U1: none", await find(u1, w.rep.D), []);
  eq(
    "findReport Q1 for U4 (disabled): none",
    await find(portalCaller(w.U4.session), w.rep.Q1),
    [],
  );
  eq(
    "findReport N for U3 (the accountant on A): A",
    await find(portalCaller(w.U3.session), w.rep.N),
    [accessOf(w.U3, w.A)],
  );

  eq(
    "refused item calls wrote no access-log row (T-LOG)",
    await db.portalAccessLog.count({
      where: { portalUserId: { in: portalUserIds } },
    }),
    logBefore,
  );
}

// ---------------------------------------------------------------------------
// 4. Withdrawals take effect on the next call (P16, P24, P33)

async function readBookText(base64: string): Promise<string> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(base64, "base64") as never);
  const parts: string[] = [];
  book.eachSheet((sheet) => {
    parts.push(sheet.name);
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        parts.push(String(cell.text ?? ""));
      });
    });
  });
  return parts.join("\n");
}

async function withdrawals() {
  section(
    "4. unpublish, unshare, disable: gone on the next call; back after re-publish / re-enable",
  );
  const u1 = portalCaller(w.U1.session);
  const a = accessOf(w.U1, w.A);
  const r = w.reports1;

  // Unpublish N: list, get, file, home, findReport.
  await r.unpublish({ publicId: w.rep.N });
  const listN = (await u1.reports.list({ access: a })).map((x) => x.id);
  check("unpublished N is gone from A's list", !listN.includes(w.rep.N));
  eq(
    "get N: NOT_FOUND",
    (await answerOf(() => u1.reports.get({ access: a, reportId: w.rep.N })))
      .code,
    "NOT_FOUND",
  );
  eq(
    "fileUrl of N's shared file: NOT_FOUND",
    (
      await answerOf(() =>
        u1.reports.fileUrl({
          access: a,
          reportId: w.rep.N,
          attachmentId: w.att.nShared.id,
        }),
      )
    ).code,
    "NOT_FOUND",
  );
  eq(
    "markViewed N: NOT_FOUND",
    (
      await answerOf(() =>
        u1.reports.markViewed({ access: a, reportId: w.rep.N }),
      )
    ).code,
    "NOT_FOUND",
  );
  check(
    "home's latest report is not N",
    (await u1.home({ access: a })).latestReport?.id !== w.rep.N,
  );
  eq(
    "findReport N: no match",
    (await u1.findReport({ reportId: w.rep.N })).matches,
    [],
  );
  await r.publish({ publicId: w.rep.N });
  check(
    "re-published N is back",
    (await u1.reports.list({ access: a })).some((x) => x.id === w.rep.N),
  );

  // Unpublish Q2: A's published-through date moves back to March.
  await r.unpublish({ publicId: w.rep.Q2 });
  const fin = await u1.financials.get({ access: a });
  eq(
    "after unpublishing Q2, A is published through March",
    fin.publishedThrough,
    "2026-03-31",
  );
  check(
    "and receives no month after March",
    fin.fundMonths.every((m) => m.month <= "2026-03-01") &&
      fin.holderMonths.every((m) => m.month <= "2026-03-01"),
  );
  check(
    "the periods strip names no Q2 report",
    !JSON.stringify(fin.periods).includes(w.rep.Q2),
  );
  eq(
    "export Q2: NOT_FOUND",
    (
      await answerOf(() =>
        u1.reports.exportXlsx({ access: a, reportId: w.rep.Q2 }),
      )
    ).code,
    "NOT_FOUND",
  );
  const book = await u1.financials.exportXlsx({
    access: a,
    view: "mine",
    grain: "month",
    from: "2026-01-01",
    to: "2026-09-01",
  });
  const text = await readBookText(book.base64);
  check(
    "the dashboard export asked through September has no month after March",
    !/Apr(il)? 2026|May 2026|Jun(e)? 2026|Jul(y)? 2026|Aug(ust)? 2026|Sep(tember)? 2026/.test(
      text,
    ) && /Mar(ch)? 2026/.test(text),
    text.slice(0, 300),
  );
  await r.publish({ publicId: w.rep.Q2 });
  eq(
    "re-published Q2: through June again",
    (await u1.financials.get({ access: a })).publishedThrough,
    "2026-06-30",
  );

  // Unshare AB from A.
  const admin = createCallerFactory(portalAdminRouter)(w.admin1);
  await admin.unshareDocument({
    documentPublicId: w.doc.AB.publicId,
    stakeholderIds: [w.A.id],
  });
  check(
    "unshared AB is gone from A's list",
    !(await u1.documents.list({ access: a })).some(
      (d) => d.id === w.doc.AB.publicId,
    ),
  );
  check(
    "and from A's home",
    !(await u1.home({ access: a })).documents.some(
      (d) => d.id === w.doc.AB.publicId,
    ),
  );
  eq(
    "fileUrl AB for A: NOT_FOUND",
    (
      await answerOf(() =>
        u1.documents.fileUrl({ access: a, documentId: w.doc.AB.publicId }),
      )
    ).code,
    "NOT_FOUND",
  );
  check(
    "B still sees AB",
    (
      await portalCaller(w.U2.session).documents.list({
        access: accessOf(w.U2, w.B),
      })
    ).some((d) => d.id === w.doc.AB.publicId),
  );
  await admin.shareDocuments({
    documentPublicIds: [w.doc.AB.publicId],
    stakeholderIds: [w.A.id],
  });

  // Disable U1's access to A: every investor procedure on it, NOT_FOUND as unknown.
  const accessId = a;
  await admin.setAccessStatus({ accessId, status: "DISABLED" });
  const unknown = await answerOf(() =>
    u1.reports.list({ access: `pa_${"0".repeat(32)}` }),
  );
  for (const [path, row] of Object.entries(catalogue())) {
    if (row.kind !== "investor") continue;
    eq(
      `disabled A: ${path} as an unknown access`,
      await answerOf(() => row.call(u1, a)),
      {
        ...unknown,
      },
    );
  }
  const me = await u1.me();
  eq(
    "me lists F only",
    me.holders.map((h) => h.access),
    [accessOf(w.U1, w.F)],
  );
  eq(
    "F still works",
    (await answerOf(() => u1.reports.list({ access: accessOf(w.U1, w.F) })))
      .code,
    "OK",
  );
  eq(
    "U3 (another person on A) still works",
    (
      await answerOf(() =>
        portalCaller(w.U3.session).reports.list({
          access: accessOf(w.U3, w.A),
        }),
      )
    ).code,
    "OK",
  );
  eq(
    "findReport Q1 for U1: no match while disabled",
    (await u1.findReport({ reportId: w.rep.Q1 })).matches,
    [],
  );
  await admin.setAccessStatus({ accessId, status: "ACTIVE" });
  eq(
    "re-enabled: A works again",
    (await answerOf(() => u1.reports.list({ access: a }))).code,
    "OK",
  );
}

// ---------------------------------------------------------------------------
// 5. The team's "See what this member sees" equals the portal (P9 acceptance)

async function holderView() {
  section("5. portalAdmin.holderView equals what the holder's portal lists");
  const admin1 = createCallerFactory(portalAdminRouter)(w.admin1);
  const admin2 = createCallerFactory(portalAdminRouter)(w.admin2);
  for (const [label, team, holder, p] of [
    ["A", admin1, w.A, w.U1],
    ["B", admin1, w.B, w.U2],
    ["F", admin2, w.F, w.U1],
  ] as const) {
    const view = await team.holderView({ stakeholderId: holder.id });
    const caller = portalCaller(p.session);
    const access = accessOf(p, holder);
    eq(
      `${label}: report ids`,
      view.reports.map((r) => r.id).sort(),
      (await caller.reports.list({ access })).map((r) => r.id).sort(),
    );
    eq(
      `${label}: document ids`,
      view.documents.map((d) => d.id).sort(),
      (await caller.documents.list({ access })).map((d) => d.id).sort(),
    );
    eq(
      `${label}: published-through date`,
      view.publishedThrough,
      (await caller.financials.get({ access })).publishedThrough,
    );
  }
  eq(
    "holderView of another company's holder: NOT_FOUND",
    (await answerOf(() => admin1.holderView({ stakeholderId: w.F.id }))).code,
    "NOT_FOUND",
  );
}

// ---------------------------------------------------------------------------
// 6. Route handlers and session rules with everything merged

async function routes() {
  section(
    "6. route handlers: sign-in, set-password, sign-out (P4–P7, S8–S11, S16, S17)",
  );
  const signIn = (
    email: string,
    password: string,
    extra: Record<string, unknown> = {},
  ) =>
    signInPOST(
      post("/portal/auth/sign-in", { body: { email, password, ...extra } }),
    );

  // Sign-in: success; refusals identical for unknown, wrong, disabled-only.
  const ok = await signIn(w.U1.email, PASSWORD, {
    next: "/portal/go/report/x",
  });
  const cookie = sessionFrom(ok);
  check("U1 signs in (200, a cookie)", ok.status === 200 && cookie !== null);
  eq(
    "next is kept when safe",
    ((await ok.json()) as { next: string }).next,
    "/portal/go/report/x",
  );
  const evil = await signIn(w.U1.email, PASSWORD, {
    next: "//evil.example/portal",
  });
  eq(
    "an unsafe next becomes /portal",
    ((await evil.json()) as { next: string }).next,
    "/portal",
  );
  const refusal = async (res: Response) => ({
    status: res.status,
    body: await res.json(),
    cookie: sessionFrom(res),
  });
  const unknown = await refusal(
    await signIn(`${EMAIL_PREFIX}nobody@example.com`, PASSWORD),
  );
  eq("unknown address: 401 with the one message", unknown, {
    status: 401,
    body: { ok: false, error: SIGN_IN_REFUSED_MESSAGE },
    cookie: null,
  });
  eq(
    "U4 (only a DISABLED access), right password: as unknown",
    await refusal(await signIn(w.U4.email, PASSWORD)),
    unknown,
  );
  eq(
    "foreign Origin: 403",
    (
      await signInPOST(
        post("/portal/auth/sign-in", {
          origin: "https://evil.example",
          body: { email: w.U1.email, password: PASSWORD },
        }),
      )
    ).status,
    403,
  );

  // Lockout: five wrong passwords lock U2; the right one is then refused alike.
  for (let i = 0; i < 5; i++) {
    eq(
      `U2 wrong password ${i + 1}: as unknown`,
      await refusal(await signIn(w.U2.email, "not-the-password-at-all")),
      unknown,
    );
  }
  const locked = await db.portalUser.findUniqueOrThrow({
    where: { id: w.U2.id },
  });
  check(
    "U2 is locked for 15 minutes",
    locked.lockedUntil !== null &&
      locked.lockedUntil.getTime() > Date.now() + 14 * 60_000,
  );
  eq(
    "U2 right password while locked: as unknown",
    await refusal(await signIn(w.U2.email, PASSWORD)),
    unknown,
  );
  eq(
    "lock wrote one ACCOUNT_LOCKED row",
    await db.portalAccessLog.count({
      where: { portalUserId: w.U2.id, event: "ACCOUNT_LOCKED" },
    }),
    1,
  );

  // Forgot password: neutral answer; throttle at 3 per 15 minutes.
  const reset = createCallerFactory(portalAuthRouter)({
    db,
    session: null,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers: new Headers({ origin: BASE }),
  } as never);
  const before = accountJobs.length;
  const answersReset: unknown[] = [];
  for (let i = 0; i < 4; i++)
    answersReset.push(await reset.requestReset({ email: w.U2.email }));
  answersReset.push(
    await reset.requestReset({ email: `${EMAIL_PREFIX}nobody@example.com` }),
  );
  answersReset.push(await reset.requestReset({ email: w.U4.email }));
  check(
    "requestReset answers alike for known, unknown and disabled-only",
    answersReset.every((x) => isDeepStrictEqual(x, answersReset[0])),
    show(answersReset),
  );
  const resets = await db.portalAccountToken.count({
    where: { portalUserId: w.U2.id, purpose: "RESET_PASSWORD" },
  });
  eq("four requests in a row issued three reset tokens (throttle)", resets, 3);
  eq(
    "no token for the unknown address or the disabled-only user",
    await db.portalAccountToken.count({ where: { portalUserId: w.U4.id } }),
    0,
  );
  check(
    "three account emails queued, all for U2",
    accountJobs.length - before === 3,
  );

  // The newest reset link sets a password through the route, clears the lock,
  // revokes U2's earlier sessions and signs in.
  const last = accountJobs[accountJobs.length - 1];
  const sent = await deliverPortalAccountEmail(last as never, capture);
  eq("the reset email is delivered (captured)", sent, "SENT");
  const token =
    mails[mails.length - 1]?.html.match(
      /\/portal\/set-password\/([A-Za-z0-9_-]{43})/,
    )?.[1] ?? "";
  check("the reset email carries a set-password link", token.length === 43);
  const oldU2 = w.U2.session;
  const setRes = await setPasswordPOST(
    post("/portal/auth/set-password", {
      body: { token, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
    }),
  );
  const newU2 = sessionFrom(setRes);
  check(
    "set-password: 200 and a new session",
    setRes.status === 200 && newU2 !== null,
  );
  const afterReset = await db.portalUser.findUniqueOrThrow({
    where: { id: w.U2.id },
  });
  check(
    "the lock is cleared",
    afterReset.lockedUntil === null && afterReset.failedSignIns === 0,
  );
  eq(
    "U2's earlier session is refused on every procedure",
    (await answerOf(() => portalCaller(oldU2).me())).code,
    "UNAUTHORIZED",
  );
  eq(
    "the new session works",
    (
      await answerOf(() =>
        portalCaller(newU2).reports.list({ access: accessOf(w.U2, w.B) }),
      )
    ).code,
    "OK",
  );
  const reuse = await refusal(
    await setPasswordPOST(
      post("/portal/auth/set-password", {
        body: {
          token,
          password: "Another-Long-Pass-2028",
          confirm: "Another-Long-Pass-2028",
        },
      }),
    ),
  );
  const bogus = await refusal(
    await setPasswordPOST(
      post("/portal/auth/set-password", {
        body: {
          token: "A".repeat(43),
          password: "Another-Long-Pass-2028",
          confirm: "Another-Long-Pass-2028",
        },
      }),
    ),
  );
  eq("a used link answers exactly as an unknown one", reuse, bogus);
  check("and sets no cookie", reuse.cookie === null && reuse.status >= 400);
  w.U2.session = newU2 ?? "";

  // P2 review: many reset calls for one address at once (as one batched
  // HTTP request would make them) do not queue and all answer alike.
  const burst = await Promise.all(
    Array.from({ length: 40 }, () =>
      answerOf(() => reset.requestReset({ email: w.U1.email })),
    ),
  );
  eq(
    "40 concurrent reset requests for U1: every one answers OK",
    burst.filter((b) => b.code !== "OK"),
    [],
  );
  const u1Resets = await db.portalAccountToken.count({
    where: { portalUserId: w.U1.id, purpose: "RESET_PASSWORD" },
  });
  check(
    "and issue at most three tokens",
    u1Resets >= 1 && u1Resets <= 3,
    String(u1Resets),
  );

  // P2 review: a body without Content-Length is capped while it is read.
  const oversized = new TextEncoder().encode(
    JSON.stringify({
      email: w.U1.email,
      password: PASSWORD,
      pad: "x".repeat(10_000),
    }),
  );
  const chunked = new NextRequest(`${BASE}/portal/auth/sign-in`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", origin: BASE }),
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < oversized.length; i += 1_000)
          controller.enqueue(oversized.slice(i, i + 1_000));
        controller.close();
      },
    }),
    duplex: "half",
  } as never);
  check(
    "the request has no Content-Length",
    chunked.headers.get("content-length") === null,
  );
  eq(
    "a 10 kB chunked body with the right password is refused as unknown",
    await refusal(await signInPOST(chunked)),
    unknown,
  );

  // Change password: other sessions of that person end, this one stays.
  const s1 = await newSession(w.U3.id);
  const s2 = await newSession(w.U3.id);
  await portalCaller(s1).changePassword({
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
  });
  eq(
    "after changePassword the other session is refused",
    (
      await answerOf(() =>
        portalCaller(s2).reports.list({ access: accessOf(w.U3, w.A) }),
      )
    ).code,
    "UNAUTHORIZED",
  );
  eq(
    "and the one that changed it still works",
    (
      await answerOf(() =>
        portalCaller(s1).reports.list({ access: accessOf(w.U3, w.A) }),
      )
    ).code,
    "OK",
  );
  eq(
    "U3's first session (made at setup) is refused too",
    (await answerOf(() => portalCaller(w.U3.session).me())).code,
    "UNAUTHORIZED",
  );
  w.U3.session = s1;

  // Sign-out ends that session at once; another session of the person stays.
  const other = await newSession(w.U1.id);
  const outRes = await signOutPOST(
    post("/portal/auth/sign-out", {
      cookie: `${portalCookieName()}=${cookie}`,
    }),
  );
  check(
    "sign-out answers (303 to the sign-in page)",
    outRes.status === 303 || (outRes.status >= 200 && outRes.status < 300),
  );
  eq(
    "the signed-out cookie is refused",
    (await answerOf(() => portalCaller(cookie).me())).code,
    "UNAUTHORIZED",
  );
  eq(
    "another session of U1 still works",
    (await answerOf(() => portalCaller(other).me())).code,
    "OK",
  );
  eq(
    "sign-out with a foreign Origin: 403",
    (
      await signOutPOST(
        post("/portal/auth/sign-out", {
          origin: "https://evil.example",
          cookie: `${portalCookieName()}=${other}`,
        }),
      )
    ).status,
    403,
  );
  eq(
    "and that session is not ended",
    (await answerOf(() => portalCaller(other).me())).code,
    "OK",
  );
  eq(
    "set-password with a foreign Origin: 403",
    (
      await setPasswordPOST(
        post("/portal/auth/set-password", {
          origin: "https://evil.example",
          body: {},
        }),
      )
    ).status,
    403,
  );
}

// ---------------------------------------------------------------------------
// 7. Last seen (known item 4d)

async function lastSeen() {
  section(
    "7. lastSeenAt: an investor call refreshes the access and the session",
  );
  const access = accessOf(w.U1, w.A);
  const rowId = w.U1.accessRowId.get(w.A.id) ?? "";
  const longAgo = new Date(Date.now() - 10 * 60_000);
  const { hashToken } = await import("@/lib/portal/token-core");
  await db.portalAccess.update({
    where: { id: rowId },
    data: { lastSeenAt: longAgo },
  });
  await db.portalSession.update({
    where: { tokenHash: hashToken(w.U1.session) },
    data: { lastSeenAt: longAgo },
  });
  await portalCaller(w.U1.session).financials.get({ access });
  const after = await db.portalAccess.findUniqueOrThrow({
    where: { id: rowId },
  });
  const sess = await db.portalSession.findUniqueOrThrow({
    where: { tokenHash: hashToken(w.U1.session) },
  });
  check(
    "PortalAccess.lastSeenAt is refreshed (financials.get, as the [access] layout calls it)",
    (after.lastSeenAt?.getTime() ?? 0) > longAgo.getTime() + 60_000,
  );
  check(
    "PortalSession.lastSeenAt is refreshed",
    sess.lastSeenAt.getTime() > longAgo.getTime() + 60_000,
  );
  const fresh = after.lastSeenAt?.getTime();
  await portalCaller(w.U1.session).reports.list({ access });
  eq(
    "within 5 minutes it is not written again",
    (
      await db.portalAccess.findUniqueOrThrow({ where: { id: rowId } })
    ).lastSeenAt?.getTime(),
    fresh,
  );
}

// ---------------------------------------------------------------------------
// 8. Answer scan: nobody receives another holder's data or an internal id

async function answerScan() {
  section(
    "8. answers: no other holder's name, email or id; no internal id; no storage key (G4, S7, S19, S28)",
  );
  // Fresh successful calls of every procedure by each person, kept per person.
  const fileKeys = new Map<string, string>(); // URL → the one key it may carry
  for (const [p, holder] of [
    [w.U1, w.A],
    [w.U1, w.F],
    [w.U2, w.B],
    [w.U3, w.A],
  ] as const) {
    const caller = portalCaller(p.session);
    const access = accessOf(p, holder);
    for (const [path, row] of Object.entries(catalogue())) {
      if (path === "changePassword") continue;
      if (path === "reports.fileUrl" || path === "documents.fileUrl") continue;
      const value = await errorOf(async () =>
        keep(p, await row.call(caller, access)),
      );
      if (
        value !== null &&
        ![
          "reports.get",
          "reports.markViewed",
          "reports.exportXlsx",
          "documents.fileUrl",
          "findReport",
        ].includes(path)
      )
        check(`${path} for ${holder.name} answered`, false, value.message);
    }
  }
  const a = accessOf(w.U1, w.A);
  const u1 = portalCaller(w.U1.session);
  const url1 = (
    await u1.reports.fileUrl({
      access: a,
      reportId: w.rep.N,
      attachmentId: w.att.nA.id,
    })
  ).url;
  fileKeys.set(url1, w.att.nA.key);
  const url2 = (
    await u1.documents.fileUrl({ access: a, documentId: w.doc.W9A.publicId })
  ).url;
  fileKeys.set(url2, w.doc.W9A.key);
  for (const url of [url1, url2]) {
    const expiresIn = new URL(url).searchParams.get("X-Amz-Expires");
    eq("a file URL lives 60 seconds", expiresIn, "60");
  }

  const allHolders = [w.A, w.B, w.C, w.D, w.E, w.F];
  const allKeys = [
    ...Object.values(w.att).map((x) => x.key),
    ...Object.values(w.doc).map((x) => x.key),
  ];
  const allBucketIds = [
    ...Object.values(w.att).map((x) => x.bucketId),
    ...Object.values(w.doc).map((x) => x.bucketId),
  ];
  const internal = [
    w.c1.id,
    w.c2.id,
    ...allHolders.map((h) => h.id),
    ...[w.U1, w.U2, w.U3, w.U4].flatMap((p) => [
      p.id,
      ...p.accessRowId.values(),
    ]),
    ...allBucketIds,
  ];
  const people = [w.U1, w.U2, w.U3, w.U4];
  for (const [p, own] of [
    [w.U1, [w.A, w.F]],
    [w.U2, [w.B]],
    [w.U3, [w.A]],
  ] as const) {
    const json = show(answers.get(p.id) ?? []);
    const forbidden: [string, string][] = [];
    for (const h of allHolders) {
      if (own.some((o) => o.id === h.id)) continue;
      forbidden.push(
        [`${h.name} (another holder's name)`, h.name],
        [`${h.email} (another holder's email)`, h.email],
      );
    }
    for (const other of people) {
      if (other.id === p.id) continue;
      forbidden.push([`another person's email`, other.email]);
      for (const pub of other.access.values())
        forbidden.push([`another person's access id`, pub]);
    }
    for (const id of internal) forbidden.push([`an internal id`, id]);
    for (const key of allKeys) forbidden.push([`a storage key`, key]);
    const hits = forbidden
      .filter(([, needle]) => json.includes(needle))
      .map(([why, needle]) => `${why}: ${needle}`);
    eq(
      `${p.email.split(".")[1]}: ${answers.get(p.id)?.length ?? 0} answers scanned, nothing forbidden`,
      hits,
      [],
    );
    check(
      `${p.email.split(".")[1]}: the scan is not vacuous`,
      (answers.get(p.id)?.length ?? 0) >= 10,
    );
  }
  for (const [url, key] of fileKeys) {
    const others = allKeys.filter((k) => k !== key && url.includes(k));
    eq("a file URL carries its own key only", others, []);
    check("and no bucket id", !allBucketIds.some((id) => url.includes(id)));
  }
}

// ---------------------------------------------------------------------------
// Cleanup

async function cleanupPortal() {
  section("cleanup");
  await db.portalAccessLog.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalSession.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalAccountToken.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalAccess.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalUser.deleteMany({ where: { id: { in: portalUserIds } } });
  await db.document.deleteMany({ where: { bucketId: { in: bucketIds } } });
  await db.memberReportAttachment.deleteMany({
    where: { bucketId: { in: bucketIds } },
  });
  await db.bucket.deleteMany({ where: { id: { in: bucketIds } } });
  const left =
    (await db.portalUser.count({
      where: { email: { startsWith: EMAIL_PREFIX } },
    })) +
    (await db.portalSession.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.portalAccountToken.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.portalAccessLog.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.bucket.count({ where: { id: { in: bucketIds } } }));
  eq(
    "portal users, sessions, tokens, null-company log rows and buckets removed",
    left,
    0,
  );
}

await runScenarios([
  ["setup", setup],
  ["coverage", coverage],
  ["sessions", sessions],
  ["accesses", accesses],
  ["items", items],
  ["withdrawals", withdrawals],
  ["holder view", holderView],
  ["routes", routes],
  ["last seen", lastSeen],
  ["answer scan", answerScan],
  ["portal cleanup", cleanupPortal],
]);
