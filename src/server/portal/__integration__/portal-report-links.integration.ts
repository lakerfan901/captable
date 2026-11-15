/**
 * Emailed report links (04-investor-portal.md P24, P25, P26, S15; package
 * P5b) against the local database. Not part of `vitest run`. Run from the
 * repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-report-links.integration.ts
 *
 * Companies are named `zz-portal-links-…`, portal users
 * `zz-portal-links.…@example.com`. No email is sent: the account-email jobs
 * are captured and rendered through the worker with a capturing `send`;
 * pg-boss is not started. Every row created is deleted at the end.
 *
 * Fixture (one company). Holders A, B, C, D, E (Members), H (throttle), P
 * and Q (two holders of one person). Report R: a notice released portal-only
 * to all of them, with a shared file and a file private to E. Report L: sent
 * before the portal (publishedAt null), to A and C. Portal users at the
 * recipients' addresses: uA (A, password set), uB (B, invited, no password;
 * B's recipient address is stored in mixed case with spaces), uC (C,
 * DISABLED), uH (H, invited), uM (P and Q, password set, the address of
 * P's recipient row); an accountant uX (ACTIVE on D, another address). E has
 * no portal user.
 *
 * Covers every row of the P25 table through `route`, `view`, `markViewed`
 * and `attachmentUrl`; unpublish / republish (the reviewer's finding: an
 * unpublished report's link shows nothing); never published vs unpublished;
 * replaced links taking precedence; `requestSetup` (one token only for the
 * invited addressee, `nextPath` of the report, the INVITE email to the
 * address on file, set-up landing on the report, the throttle, the same
 * answer everywhere); the signed-in shortcut and the chooser through
 * `findReport`; the proxy buckets of the two new procedures; no address,
 * name, token or internal id in any answer.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { reportEmailJob } from "@/jobs/governance-report-email";
import { reportFileJob } from "@/jobs/governance-report-file";
import {
  deliverPortalAccountEmail,
  type PortalAccountEmailDeps,
} from "@/jobs/portal-account-email";
import { todayInZone } from "@/lib/governance/dates";
import { safeNextPath } from "@/lib/portal/next-path";
import { classifyRequest } from "@/lib/rate-limit";
import { signReportToken } from "@/server/governance/tokens";
import {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  errorOf,
  newMember,
  runScenarios,
  section,
  setCompanyPrefix,
  setToday,
  subscribe,
  type TestCompany,
  usd,
} from "@/server/llc/__integration__/harness";
import { setPasswordWithToken } from "@/server/portal/account";
import {
  type PortalAccountEmailData,
  portalAccountEmailJob,
} from "@/server/portal/account-email";
import { createPortalSession, portalCookieName } from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { memberReportViewRouter } from "@/trpc/routers/member-report-view-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";

setCompanyPrefix("zz-portal-links-");
const EMAIL_PREFIX = "zz-portal-links.";
const BASE = "http://localhost:3000";
const FACTS = { ip: "203.0.113.77", userAgent: "portal-links-integration" };
const GOOD_PASSWORD = "orchard-lantern-quietly-71";

// pg-boss is not started: the filing job a release queues is dropped, the
// account-email jobs are captured.
(reportFileJob as { emit: unknown }).emit = () => Promise.resolve();
// `replaceLink` queues the report email for the new link: captured, never sent.
const reportEmails: unknown[] = [];
(reportEmailJob as { bulkEmit: unknown }).bulkEmit = (items: unknown[]) => {
  reportEmails.push(...items);
  return Promise.resolve(null);
};
const emitted: PortalAccountEmailData[] = [];
Object.assign(portalAccountEmailJob, {
  emit: (data: PortalAccountEmailData) => {
    emitted.push(data);
    return Promise.resolve(null);
  },
});
const takeEmits = () => emitted.splice(0, emitted.length);

const mails: { to: string; subject: string; html: string }[] = [];
const capture: PortalAccountEmailDeps = {
  send: ((options) => {
    mails.push({
      to: String(options.to),
      subject: String(options.subject),
      html: String(options.html),
    });
    return Promise.resolve({
      emailLogId: null,
      sentAt: new Date(),
      messageId: null,
    });
  }) as PortalAccountEmailDeps["send"],
  now: () => new Date(),
};
const takeMails = () => mails.splice(0, mails.length);
function linkToken(html: string): string | null {
  const m = html.match(/\/portal\/set-password\/([A-Za-z0-9_-]{43})/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Bookkeeping and callers

const portalUserIds: string[] = [];
const bucketIds: string[] = [];
/** Every answer of a public link procedure, for the leak scan. */
const answers: unknown[] = [];

async function newPortalUser(email: string, passwordSet: boolean) {
  const user = await db.portalUser.create({
    data: {
      email,
      // Only "is a password set" matters to the link; no sign-in here uses it.
      passwordHash: passwordSet ? "$2b$12$not-a-real-hash-for-links" : null,
      passwordSetAt: passwordSet ? new Date() : null,
    },
  });
  portalUserIds.push(user.id);
  return user;
}

function grant(
  portalUserId: string,
  companyId: string,
  stakeholderId: string,
  status: "ACTIVE" | "DISABLED" = "ACTIVE",
) {
  return db.portalAccess.create({
    data: {
      publicId: `pa_${randomUUID().replace(/-/g, "")}`,
      portalUserId,
      companyId,
      stakeholderId,
      status,
      disabledAt: status === "DISABLED" ? new Date() : null,
      invitedById: "portal-links-integration",
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

/** The public link router as a browser on the token page may call it (no-referrer: `Origin` may be `null`). */
const link = (cookie?: string) => {
  const headers = new Headers({ origin: "null" });
  if (cookie) headers.set("cookie", `${portalCookieName()}=${cookie}`);
  return createCallerFactory(memberReportViewRouter)({
    db,
    session: null,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers,
  } as never);
};

function portalCaller(sessionToken: string) {
  const headers = new Headers();
  headers.set("cookie", `${portalCookieName()}=${sessionToken}`);
  headers.set("origin", BASE);
  return createCallerFactory(portalRouter)({
    db,
    session: null,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers,
  } as never);
}

/** `eq` for objects and arrays (deep equality). */
function same(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    isDeepStrictEqual(actual, expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  const error = await errorOf(async () => {
    answers.push(await fn());
  });
  return error === null ? "OK" : (error.code ?? error.message);
}

async function routeOf(token: string) {
  const r = await link().route({ token });
  answers.push(r);
  return r;
}

async function setupOf(token: string) {
  const r = await link().requestSetup({ token });
  answers.push(r);
  return r;
}

async function testBucket(c: TestCompany, label: string) {
  const key = `${c.id}/zz-portal-links/${label}-${randomUUID().slice(0, 8)}.pdf`;
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

function paragraph(text: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

const tokensOf = (portalUserId: string) =>
  db.portalAccountToken.findMany({
    where: { portalUserId },
    orderBy: { createdAt: "asc" },
  });

// ---------------------------------------------------------------------------
// Fixture

type Admin = Awaited<ReturnType<typeof createAdmin>>;
const reportsCallerOf = (admin: Admin) =>
  createCallerFactory(memberReportRouter)(admin.context);
type ReportsCaller = ReturnType<typeof reportsCallerOf>;
type Holder = { id: string; name: string; email: string };
interface World {
  c: TestCompany;
  reports: ReportsCaller;
  h: Record<"A" | "B" | "C" | "D" | "E" | "H" | "J" | "P" | "Q", Holder>;
  R: string;
  rId: string;
  L: string;
  /** Recipient ids on R and L, by holder. */
  rr: Record<string, string>;
  lr: Record<string, string>;
  files: { shared: string; privateE: string };
  users: Record<
    "A" | "B" | "C" | "H" | "J" | "M" | "X",
    { id: string; email: string }
  >;
  acc: Record<"A" | "B" | "C" | "H" | "MP" | "MQ" | "XD", string>;
  sessions: { A: string; C: string; M: string; X: string };
}
let w: World;

async function tokenOf(recipientId: string): Promise<string> {
  return signReportToken(
    await db.memberReportRecipient.findUniqueOrThrow({
      where: { id: recipientId },
    }),
  );
}

async function setup() {
  section("setup");
  const c = await createCompany("one");
  const names = ["A", "B", "C", "D", "E", "H", "J", "P", "Q"] as const;
  const h = {} as World["h"];
  for (const n of names) {
    h[n] = await newMember(c, `${n} Member`);
    await subscribe(c, h[n].id, usd(50_000), {
      cents: usd(50_000),
      receivedOn: "2026-11-10",
    });
  }
  setToday(todayInZone(new Date(), c.timezone));
  const admin = await createAdmin(c);
  const reports = reportsCallerOf(admin);

  // R: a notice released portal-only to every holder.
  const { publicId: R } = await reports.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await reports.update({
    publicId: R,
    title: "Notice to Members",
    figures: {},
    commentary: [paragraph("The notice body.")],
  });
  const rReport = await db.memberReport.findFirstOrThrow({
    where: { companyId: c.id, publicId: R },
  });
  const sharedBucket = await testBucket(c, "shared-letter");
  const privateBucket = await testBucket(c, "letter-for-e");
  const shared = await db.memberReportAttachment.create({
    data: {
      reportId: rReport.id,
      companyId: c.id,
      kind: "GENERAL",
      name: "Shared letter.pdf",
      bucketId: sharedBucket.id,
      stakeholderId: null,
    },
  });
  const privateE = await db.memberReportAttachment.create({
    data: {
      reportId: rReport.id,
      companyId: c.id,
      kind: "GENERAL",
      name: "Letter for E.pdf",
      bucketId: privateBucket.id,
      stakeholderId: h.E.id,
    },
  });
  await reports.release({
    publicId: R,
    stakeholderIds: names.map((n) => h[n].id),
    email: false,
  });
  const rRows = await db.memberReportRecipient.findMany({
    where: { reportId: rReport.id },
  });
  const rr: Record<string, string> = {};
  for (const row of rRows) {
    const n = names.find((x) => h[x].id === row.stakeholderId);
    if (n) rr[n] = row.id;
  }
  eq("R has a recipient row per holder", Object.keys(rr).length, names.length);
  check(
    "each recipient row carries the holder's address",
    rRows.every(
      (row) =>
        row.email ===
        names.map((n) => h[n]).find((x) => x.id === row.stakeholderId)?.email,
    ),
  );
  // B's address as the email was addressed: mixed case and spaces.
  await db.memberReportRecipient.update({
    where: { id: rr.B },
    data: { email: `  ${h.B.email.toUpperCase()} ` },
  });

  // L: sent before the portal, to A and C.
  const lRow = await db.memberReport.create({
    data: {
      publicId: `zzlinks${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      companyId: c.id,
      type: "NOTICE",
      status: "SENT",
      noticeKind: "GENERAL",
      title: "Old notice",
      commentary: [],
      figures: {},
      frozenContent: { title: "Old notice", doc: [] },
      frozenHash: "x",
      sentAt: new Date(),
      authorId: "portal-links-integration",
    },
  });
  const lr: Record<string, string> = {};
  for (const n of ["A", "C"] as const) {
    const row = await db.memberReportRecipient.create({
      data: {
        reportId: lRow.id,
        companyId: c.id,
        stakeholderId: h[n].id,
        name: h[n].name,
        email: h[n].email,
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        sentAt: new Date(),
        sendCount: 1,
      },
    });
    lr[n] = row.id;
  }

  // Portal users at the recipients' addresses.
  const uA = await newPortalUser(h.A.email, true);
  const uB = await newPortalUser(h.B.email, false);
  const uC = await newPortalUser(h.C.email, true);
  const uH = await newPortalUser(h.H.email, false);
  const uJ = await newPortalUser(h.J.email, false);
  const uM = await newPortalUser(h.P.email, true);
  const uX = await newPortalUser(
    `${EMAIL_PREFIX}accountant.${randomUUID().slice(0, 8)}@example.com`,
    true,
  );
  const accA = await grant(uA.id, c.id, h.A.id);
  const accB = await grant(uB.id, c.id, h.B.id);
  const accC = await grant(uC.id, c.id, h.C.id, "DISABLED");
  const accH = await grant(uH.id, c.id, h.H.id);
  await grant(uJ.id, c.id, h.J.id);
  const accMP = await grant(uM.id, c.id, h.P.id);
  const accMQ = await grant(uM.id, c.id, h.Q.id);
  const accXD = await grant(uX.id, c.id, h.D.id);

  w = {
    c,
    reports,
    h,
    R,
    rId: rReport.id,
    L: lRow.publicId,
    rr,
    lr,
    files: { shared: shared.id, privateE: privateE.id },
    users: {
      A: uA,
      B: uB,
      C: uC,
      H: uH,
      J: uJ,
      M: uM,
      X: uX,
    },
    acc: {
      A: accA.publicId,
      B: accB.publicId,
      C: accC.publicId,
      H: accH.publicId,
      MP: accMP.publicId,
      MQ: accMQ.publicId,
      XD: accXD.publicId,
    },
    sessions: {
      A: await sessionFor(uA.id),
      C: await sessionFor(uC.id),
      M: await sessionFor(uM.id),
      X: await sessionFor(uX.id),
    },
  };
  check("fixtures created", true);
}

// ---------------------------------------------------------------------------
// 1. The P25 table on a published report

async function table() {
  section(
    "1. P25 on a published report: route, view, markViewed, attachmentUrl",
  );
  const expect: [string, string, string, boolean][] = [
    // [holder, state, explanation, setupNeeded]
    ["A", "PORTAL", "ACTIVE, password set", false],
    ["B", "PORTAL", "ACTIVE, no password (mixed-case address)", true],
    ["C", "ACCESS_OFF", "DISABLED", false],
    [
      "D",
      "LEGACY",
      "never invited at this address (an accountant has access)",
      false,
    ],
    ["E", "LEGACY", "never invited (no portal user at all)", false],
  ];
  for (const [n, state, why, setupNeeded] of expect) {
    const token = await tokenOf(w.rr[n] as string);
    const r = await routeOf(token);
    eq(`${n} (${why}): route state`, r.state, state);
    eq(`${n}: setupNeeded`, r.setupNeeded, setupNeeded);
    eq(
      `${n}: reportId`,
      r.reportId,
      state === "PORTAL" || state === "LEGACY" ? w.R : null,
    );
    eq(`${n}: company name only`, r.company.name, w.c.name);
    const content = state === "LEGACY";
    eq(
      `${n}: view ${content ? "returns the report" : "is NOT_FOUND"}`,
      await codeOf(() => link().view({ token })),
      content ? "OK" : "NOT_FOUND",
    );
    eq(
      `${n}: markViewed ${content ? "works" : "is NOT_FOUND"}`,
      await codeOf(() => link().markViewed({ token })),
      content ? "OK" : "NOT_FOUND",
    );
    eq(
      `${n}: attachmentUrl (shared file) ${content ? "works" : "is NOT_FOUND"}`,
      await codeOf(() =>
        link().attachmentUrl({ token, attachmentId: w.files.shared }),
      ),
      content ? "OK" : "NOT_FOUND",
    );
  }
  // The reportId the page links to is a safe sign-in `next`.
  eq(
    "the landing path passes safeNextPath unchanged",
    safeNextPath(`/portal/go/report/${w.R}`),
    `/portal/go/report/${w.R}`,
  );

  section("1b. read-only page content and K-1 / private-file rules unchanged");
  const eToken = await tokenOf(w.rr.E as string);
  const eView = await link().view({ token: eToken });
  answers.push(eView);
  check(
    "E's page: the shared file and E's own file",
    eView.state === "OK" &&
      eView.attachments
        .map((a) => a.name)
        .sort()
        .join(",") === "Letter for E.pdf,Shared letter.pdf",
  );
  const dToken = await tokenOf(w.rr.D as string);
  const dView = await link().view({ token: dToken });
  answers.push(dView);
  check(
    "D's page: only the shared file (never E's)",
    dView.state === "OK" &&
      dView.attachments.map((a) => a.name).join(",") === "Shared letter.pdf",
  );
  eq(
    "D cannot open E's private file",
    await codeOf(() =>
      link().attachmentUrl({ token: dToken, attachmentId: w.files.privateE }),
    ),
    "NOT_FOUND",
  );
  const eRow = await db.memberReportRecipient.findUniqueOrThrow({
    where: { id: w.rr.E as string },
  });
  check("markViewed recorded E's first view", eRow.firstViewedAt !== null);
  const aRow = await db.memberReportRecipient.findUniqueOrThrow({
    where: { id: w.rr.A as string },
  });
  eq("a PORTAL link records no token-page view", aRow.viewCount, 0);

  section(
    "1c. a report sent before the portal: today's page, whatever the access",
  );
  for (const n of ["A", "C"] as const) {
    const token = await tokenOf(w.lr[n] as string);
    const r = await routeOf(token);
    eq(`L/${n}: LEGACY`, r.state, "LEGACY");
    eq(`L/${n}: no reportId (no sign-in link)`, r.reportId, null);
    eq(
      `L/${n}: view OK (access ${n === "A" ? "ACTIVE" : "DISABLED"} does not matter)`,
      await codeOf(() => link().view({ token })),
      "OK",
    );
  }

  section("1d. invalid tokens");
  eq(
    "garbage token: route NOT_FOUND",
    await codeOf(() => link().route({ token: "x".repeat(40) })),
    "NOT_FOUND",
  );
  const aToken = await tokenOf(w.rr.A as string);
  eq(
    "tampered token: route NOT_FOUND",
    await codeOf(() => link().route({ token: `${aToken.slice(0, -2)}xx` })),
    "NOT_FOUND",
  );
}

// ---------------------------------------------------------------------------
// 2. Unpublish / republish, replaced links

async function unpublish() {
  section("2. unpublish: every link shows 'no longer available', nothing else");
  const tokens = Object.fromEntries(
    await Promise.all(
      Object.entries(w.rr).map(async ([n, id]) => [n, await tokenOf(id)]),
    ),
  ) as Record<string, string>;
  await w.reports.unpublish({ publicId: w.R });
  for (const n of ["A", "B", "C", "D", "E"]) {
    const token = tokens[n] as string;
    const r = await routeOf(token);
    eq(`unpublished, ${n}: WITHDRAWN`, r.state, "WITHDRAWN");
    eq(`unpublished, ${n}: no reportId`, r.reportId, null);
    eq(
      `unpublished, ${n}: view NOT_FOUND`,
      await codeOf(() => link().view({ token })),
      "NOT_FOUND",
    );
    eq(
      `unpublished, ${n}: attachmentUrl NOT_FOUND`,
      await codeOf(() =>
        link().attachmentUrl({ token, attachmentId: w.files.shared }),
      ),
      "NOT_FOUND",
    );
    eq(
      `unpublished, ${n}: markViewed NOT_FOUND`,
      await codeOf(() => link().markViewed({ token })),
      "NOT_FOUND",
    );
  }
  const before = (await tokensOf(w.users.B.id)).length;
  same(
    "unpublished, B: requestSetup answers the same",
    await setupOf(tokens.B as string),
    { ok: true },
  );
  eq(
    "unpublished, B: no set-up token issued",
    (await tokensOf(w.users.B.id)).length,
    before,
  );
  eq("unpublished: no email queued", takeEmits().length, 0);
  // The pre-portal report is not affected.
  eq(
    "L stays LEGACY while R is unpublished",
    (await routeOf(await tokenOf(w.lr.A as string))).state,
    "LEGACY",
  );

  section("2b. replaced links win over every report state");
  const oldA = tokens.A as string;
  await w.reports.replaceLink({ publicId: w.R, recipientId: w.rr.A as string });
  eq("replaceLink queued its report email (captured)", reportEmails.length, 1);
  eq(
    "unpublished + replaced: REPLACED",
    (await routeOf(oldA)).state,
    "REPLACED",
  );
  eq(
    "unpublished + replaced: the new link is WITHDRAWN",
    (await routeOf(await tokenOf(w.rr.A as string))).state,
    "WITHDRAWN",
  );

  section("2c. publish again restores both");
  await w.reports.publish({ publicId: w.R });
  for (const [n, state] of [
    ["B", "PORTAL"],
    ["C", "ACCESS_OFF"],
    ["D", "LEGACY"],
    ["E", "LEGACY"],
  ] as const) {
    eq(
      `republished, ${n}: ${state}`,
      (await routeOf(tokens[n] as string)).state,
      state,
    );
  }
  eq(
    "republished: old A link still REPLACED",
    (await routeOf(oldA)).state,
    "REPLACED",
  );
  eq(
    "republished: new A link PORTAL",
    (await routeOf(await tokenOf(w.rr.A as string))).state,
    "PORTAL",
  );
  eq(
    "republished, E: view returns content again",
    await codeOf(() => link().view({ token: tokens.E as string })),
    "OK",
  );
}

// ---------------------------------------------------------------------------
// 3. requestSetup

async function setupLinks() {
  section(
    "3. requestSetup: only the invited addressee, to the address on file",
  );
  takeEmits();
  const nonInvited: [string, string][] = [
    ["A (password set)", await tokenOf(w.rr.A as string)],
    ["C (DISABLED)", await tokenOf(w.rr.C as string)],
    [
      "D (never invited; accountant has access)",
      await tokenOf(w.rr.D as string),
    ],
    ["E (no portal user)", await tokenOf(w.rr.E as string)],
    ["L/A (before the portal)", await tokenOf(w.lr.A as string)],
    ["garbage", "y".repeat(48)],
  ];
  const tokenCount = async () =>
    db.portalAccountToken.count({
      where: { portalUserId: { in: portalUserIds } },
    });
  const startCount = await tokenCount();
  for (const [label, token] of nonInvited) {
    same(`${label}: { ok: true }`, await setupOf(token), { ok: true });
  }
  eq("none of them issued a token", await tokenCount(), startCount);
  eq("none of them queued an email", takeEmits().length, 0);

  const bToken = await tokenOf(w.rr.B as string);
  same("B: { ok: true }", await setupOf(bToken), { ok: true });
  const bTokens = await tokensOf(w.users.B.id);
  eq("B: one token issued", bTokens.length, 1);
  const t = bTokens[0];
  eq("B: purpose SET_PASSWORD", t?.purpose, "SET_PASSWORD");
  eq(
    "B: nextPath is the report's landing",
    t?.nextPath,
    `/portal/go/report/${w.R}`,
  );
  eq("B: requestIp recorded", t?.requestIp, FACTS.ip);
  const jobs = takeEmits();
  same("B: one INVITE job for B's access", jobs, [
    {
      kind: "INVITE",
      tokenId: t?.id,
      accessId: (
        await db.portalAccess.findFirstOrThrow({ where: { publicId: w.acc.B } })
      ).id,
    },
  ]);
  check(
    "the token is nowhere in the job",
    !JSON.stringify(jobs).includes(bToken),
  );

  // The worker sends it to the portal user's address on file.
  const outcome = await deliverPortalAccountEmail(
    jobs[0] as PortalAccountEmailData,
    capture,
  );
  eq("the INVITE email is sent", outcome, "SENT");
  const [mail] = takeMails();
  eq("it goes to B's portal address", mail?.to, w.users.B.email);
  check(
    "the subject names no address and no link",
    mail !== undefined &&
      !mail.subject.includes("@") &&
      !mail.subject.includes("/portal/"),
  );
  const setupToken = linkToken(mail?.html ?? "");
  check("the email carries a set-password link", setupToken !== null);
  check(
    "the email does not carry the report token",
    !(mail?.html ?? "").includes(bToken),
  );

  section("3b. set the password: lands on the report");
  const set = await setPasswordWithToken(db, {
    token: setupToken,
    password: GOOD_PASSWORD,
    ip: FACTS.ip,
    userAgent: FACTS.userAgent,
  });
  check("the password is set", set.ok);
  if (set.ok) {
    eq("next is the report landing", set.next, `/portal/go/report/${w.R}`);
    const found = await portalCaller(set.sessionToken).findReport({
      reportId: w.R,
    });
    same(
      "findReport: B's access",
      found.matches.map((m) => m.access),
      [w.acc.B],
    );
  }
  takeEmits(); // the "password changed" notice
  const after = await routeOf(bToken);
  eq("after set-up, B: PORTAL", after.state, "PORTAL");
  eq("after set-up, B: no set-up needed", after.setupNeeded, false);
  const count = (await tokensOf(w.users.B.id)).length;
  same("after set-up, B: requestSetup", await setupOf(bToken), { ok: true });
  eq(
    "after set-up, B: no new token",
    (await tokensOf(w.users.B.id)).length,
    count,
  );

  section("3c. throttle: 3 per 15 minutes, counting the invitation");
  // H was invited (one SET_PASSWORD token already issued 1 minute ago).
  await db.portalAccountToken.create({
    data: {
      portalUserId: w.users.H.id,
      tokenHash: `zz-links-${randomUUID()}`,
      purpose: "SET_PASSWORD",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      createdAt: new Date(Date.now() - 60_000),
    },
  });
  takeEmits();
  const hToken = await tokenOf(w.rr.H as string);
  const results: unknown[] = [];
  for (let i = 0; i < 4; i++) results.push(await setupOf(hToken));
  check(
    "four requests: the same answer each time",
    results.every((r) => isDeepStrictEqual(r, { ok: true })),
  );
  const hTokens = await tokensOf(w.users.H.id);
  eq(
    "H: 3 tokens in 15 minutes (1 invitation + 2 set-up links)",
    hTokens.length,
    3,
  );
  eq("H: 2 emails queued", takeEmits().length, 2);
  eq(
    "H: only the newest set-up link is usable",
    hTokens.filter((x) => x.usedAt === null).length,
    1,
  );

  section("3d. at the limit, a burst adds nothing");
  await Promise.all(Array.from({ length: 5 }, () => setupOf(hToken)));
  eq("H: still 3 tokens", (await tokensOf(w.users.H.id)).length, 3);
  eq("H: no email queued", takeEmits().length, 0);

  section("3e. concurrent requests from zero: exactly the throttle's 3");
  const jToken = await tokenOf(w.rr.J as string);
  eq("J: no token yet", (await tokensOf(w.users.J.id)).length, 0);
  const burst = await Promise.all(
    Array.from({ length: 5 }, () => setupOf(jToken)),
  );
  check(
    "five concurrent requests: the same answer each time",
    burst.every((r) => isDeepStrictEqual(r, { ok: true })),
  );
  eq("J: exactly 3 tokens", (await tokensOf(w.users.J.id)).length, 3);
  eq("J: exactly 3 emails queued", takeEmits().length, 3);

  section(
    "3f. production with the mail catcher: UNAVAILABLE before any look-up",
  );
  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV;
  const bCount = (await tokensOf(w.users.B.id)).length;
  const jCount = (await tokensOf(w.users.J.id)).length;
  env.NODE_ENV = "production";
  try {
    same("garbage token: UNAVAILABLE", await setupOf("z".repeat(48)), {
      ok: false,
      reason: "UNAVAILABLE",
    });
    same("J's token: UNAVAILABLE", await setupOf(jToken), {
      ok: false,
      reason: "UNAVAILABLE",
    });
  } finally {
    env.NODE_ENV = nodeEnv;
  }
  eq("no token issued", (await tokensOf(w.users.J.id)).length, jCount);
  eq("B unchanged", (await tokensOf(w.users.B.id)).length, bCount);
  eq("no email queued", takeEmits().length, 0);
}

// ---------------------------------------------------------------------------
// 4. Signed-in shortcut, forwarded link, chooser

async function signedIn() {
  section("4. signed-in shortcut, forwarded link, chooser");
  const aToken = await tokenOf(w.rr.A as string);
  // The answer depends on the recipient row only, never on the visitor.
  const anon = await routeOf(aToken);
  const asC = await link(w.sessions.C).route({ token: aToken });
  answers.push(asC);
  check(
    "route is the same for any visitor (forwarded link)",
    isDeepStrictEqual(anon, asC),
  );
  same(
    "A's own session: findReport matches A (the page redirects)",
    (
      await portalCaller(w.sessions.A).findReport({ reportId: w.R })
    ).matches.map((m) => m.access),
    [w.acc.A],
  );
  eq(
    "a signed-in stranger (C, access off) opening A's forwarded link: no match (interstitial)",
    (await portalCaller(w.sessions.C).findReport({ reportId: w.R })).matches
      .length,
    0,
  );
  eq(
    "...and view still gives that browser nothing",
    await codeOf(() => link(w.sessions.C).view({ token: aToken })),
    "NOT_FOUND",
  );
  const dToken = await tokenOf(w.rr.D as string);
  eq(
    "D's own link (accountant has access, D not invited): LEGACY",
    (await routeOf(dToken)).state,
    "LEGACY",
  );
  same(
    "...and the accountant opens the report in the portal as D",
    (
      await portalCaller(w.sessions.X).findReport({ reportId: w.R })
    ).matches.map((m) => m.access),
    [w.acc.XD],
  );

  section("4b. one person for two recipient holders: the chooser");
  const pToken = await tokenOf(w.rr.P as string);
  eq(
    "P's link (addressee uM, password set): PORTAL",
    (await routeOf(pToken)).state,
    "PORTAL",
  );
  eq(
    "Q's link (addressed to Q, uM is not Q's addressee): LEGACY",
    (await routeOf(await tokenOf(w.rr.Q as string))).state,
    "LEGACY",
  );
  const m = await portalCaller(w.sessions.M).findReport({ reportId: w.R });
  same(
    "findReport for uM: two matches (P and Q) -> chooser",
    m.matches.map((x) => x.access).sort(),
    [w.acc.MP, w.acc.MQ].sort(),
  );

  section("4c. disabling and re-enabling changes the link on the next request");
  const accA = await db.portalAccess.findFirstOrThrow({
    where: { publicId: w.acc.A },
  });
  await db.portalAccess.update({
    where: { id: accA.id },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  eq("A disabled: ACCESS_OFF", (await routeOf(aToken)).state, "ACCESS_OFF");
  eq(
    "A disabled: view NOT_FOUND (no content from an old email)",
    await codeOf(() => link().view({ token: aToken })),
    "NOT_FOUND",
  );
  await db.portalAccess.update({
    where: { id: accA.id },
    data: { status: "ACTIVE", disabledAt: null },
  });
  eq("A re-enabled: PORTAL", (await routeOf(aToken)).state, "PORTAL");
}

// ---------------------------------------------------------------------------
// 5. Buckets and leaks

function bucketsAndLeaks(): Promise<void> {
  section("5. proxy buckets of the new procedures");
  eq(
    "memberReportView.route is token-api",
    classifyRequest("POST", "/api/trpc/memberReportView.route"),
    "token-api",
  );
  eq(
    "memberReportView.requestSetup is account",
    classifyRequest("POST", "/api/trpc/memberReportView.requestSetup"),
    "account",
  );

  section("5b. no address, name, token or internal id in any answer");
  const json = JSON.stringify(
    answers.filter(
      (a) =>
        // The read-only page legitimately shows the recipient's name.
        !(a && typeof a === "object" && "recipient" in a),
    ),
  );
  const secrets: [string, string][] = [];
  for (const [n, holder] of Object.entries(w.h)) {
    secrets.push([`${n}'s address`, holder.email.toLowerCase()]);
    secrets.push([`${n}'s holder id`, holder.id]);
  }
  for (const [n, u] of Object.entries(w.users)) {
    secrets.push([`${n}'s portal user id`, u.id]);
  }
  for (const [n, id] of Object.entries(w.rr))
    secrets.push([`R/${n} recipient id`, id]);
  secrets.push(["report internal id", w.rId]);
  const leaks = secrets.filter(([, s]) =>
    json.toLowerCase().includes(s.toLowerCase()),
  );
  same(
    "no leak",
    leaks.map(([label]) => label),
    [],
  );
  check("no 'key' field", !/"key"\s*:/.test(json));
  check(
    "no access public id",
    !Object.values(w.acc).some((a) => json.includes(a)),
  );
  return Promise.resolve();
}

async function cleanupPortal() {
  section("cleanup: portal users, tokens, sessions, buckets");
  await db.portalAccessLog.deleteMany({
    where: { portalUserId: { in: portalUserIds } },
  });
  await db.portalAccountToken.deleteMany({
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
    (await db.portalAccountToken.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.bucket.count({ where: { id: { in: bucketIds } } }));
  eq("portal users, tokens and buckets removed", left, 0);
}

await runScenarios([
  ["setup", setup],
  ["P25 table", table],
  ["unpublish", unpublish],
  ["requestSetup", setupLinks],
  ["signed in", signedIn],
  ["buckets and leaks", bucketsAndLeaks],
  ["portal cleanup", cleanupPortal],
]);
