/**
 * Document sharing and the portal document procedures (04-investor-portal.md
 * P13, P14, P16, P28, P29, P31, S3, S6, S19; package P6) against the local
 * database and the local MinIO of `.env`. Not part of `vitest run`. Run from
 * the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-documents.integration.ts
 *
 * Two LLCs. Company 1: A, B (Preferred Members), C (Common Member), D
 * (prospect), E (Financial-Interest-only), later G (admitted after a share).
 * Company 2: F. Portal user 1 has access to A and F, user 2 to B, user 3 to
 * C, user 4 to G. Team callers: an ADMIN of each company, a custom role with
 * `portal: read` only, a custom role without `portal`.
 *
 * Covers: no shares → empty lists; share with A and C, B refused by id;
 * presets stored as a frozen list, a later Member is not on it and is
 * reported missing; W-9 and every other holder tie refused for another
 * holder (all-or-nothing), hand-inserted wrong grants ignored at read;
 * cross-company isolation on both sides (team and investor, by public and
 * internal id); concurrent duplicate share (one row, one audit naming the
 * holder); revoke then list/open refused; disabled access; a real upload to
 * MinIO opened through the 60-second URL, which then expires; log rows (one
 * per open, none on a refusal); the access log (company rows, account
 * events, paging); RBAC refusals; no storage key, bucket name or bucket id
 * in any response. Every row and object it creates is deleted at the end.
 *
 * Section 10b (P10, "new documents" emails): default off (no notification
 * from any share without `notify`); 20 documents shared in one action with
 * `notify` give one row per person with ACTIVE, password-set access to a
 * holder that gained a document (a two-holder person gets one; disabled,
 * password-less and already-had-everything people get none);
 * `notificationsQueued`; two concurrent job runs send once, a third run
 * sends nothing; the mail guard before any write (procedure and job); the
 * send-time re-check; no token, file, document name or other holder's name
 * in the email; one real send through `sendMail` (EmailLog row on the right
 * holder) read back from the local mail catcher (Mailpit, API on 8025).
 */
import { randomUUID } from "node:crypto";
import { generatePublicId } from "@/common/id";
import {
  deliverPortalNotification,
  type PortalNotificationDeps,
} from "@/jobs/portal-notification-email";
import { todayInZone } from "@/lib/governance/dates";
import { deleteObject, uploadFile } from "@/server/file-uploads";
import {
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  errorOf,
  issueCommon,
  newMember,
  race,
  runScenarios,
  section,
  setCompanyPrefix,
  setToday,
  subscribe,
  type TestCompany,
  usd,
} from "@/server/llc/__integration__/harness";
import { writePortalLog } from "@/server/portal/log";
import {
  type PortalNotificationEmailData,
  portalNotificationEmailJob,
} from "@/server/portal/notification-email";
import { createPortalSession, portalCookieName } from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import {
  type ShareActor,
  shareDocumentsInTx,
} from "@/trpc/routers/portal-admin-router/procedures/share-documents";
import { portalAdminRouter } from "@/trpc/routers/portal-admin-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";

setCompanyPrefix("zz-portal-docs-");
const EMAIL_PREFIX = "zz-portal-docs.";
const BASE = "http://localhost:3000";
const FACTS = { ip: "203.0.113.42", userAgent: "portal-documents-integration" };
const LOG_FACTS = { requestIp: FACTS.ip, userAgent: FACTS.userAgent };
const PRIVATE_BUCKET = process.env.UPLOAD_BUCKET_PRIVATE ?? "";
const FILE_BODY = `portal-documents-integration ${randomUUID()}`;

// Captured `portal.notification-email` jobs (P10): nothing reaches pg-boss.
const notifyJobs: { data: PortalNotificationEmailData; options: unknown }[] =
  [];
Object.assign(portalNotificationEmailJob, {
  emit: (data: PortalNotificationEmailData, options?: unknown) => {
    notifyJobs.push({ data, options });
    return Promise.resolve(null);
  },
});

// Every JSON response, scanned at the end for storage keys and bucket ids.
const responses: { label: string; json: string }[] = [];
function seen<T>(label: string, value: T): T {
  responses.push({ label, json: JSON.stringify(value) });
  return value;
}

const portalUserIds: string[] = [];
const bucketIds: string[] = [];
const objectKeys: string[] = [];

// ---------------------------------------------------------------------------
// Fixtures

type Holder = { id: string; name: string };

const realToday = (c: TestCompany) => todayInZone(new Date(), c.timezone);

let c1: TestCompany;
let c2: TestCompany;
let A: Holder;
let B: Holder;
let C: Holder;
let D: Holder;
let E: Holder;
let F: Holder;
let G: Holder;
let admin1: Awaited<ReturnType<typeof createAdmin>>;
let admin2: Awaited<ReturnType<typeof createAdmin>>;
let reader: Awaited<ReturnType<typeof createAdmin>>;
let outsider: Awaited<ReturnType<typeof createAdmin>>;
let team1: ReturnType<typeof teamCaller>;
let team2: ReturnType<typeof teamCaller>;
let actor1: ShareActor;

/** Portal users with a live session; `access[holderId]` is the access public id. */
interface Investor {
  userId: string;
  token: string;
  access: Map<string, string>;
}
let U1: Investor;
let U2: Investor;
let U3: Investor;
let U4: Investor;

const docs: Record<string, { id: string; publicId: string; key: string }> = {};

function teamCaller(ctx: Awaited<ReturnType<typeof createAdmin>>["context"]) {
  return createCallerFactory(portalAdminRouter)(ctx);
}

function portalCaller(token: string | null, teamSession: unknown = null) {
  const headers = new Headers();
  if (token !== null) headers.set("cookie", `${portalCookieName()}=${token}`);
  headers.set("origin", BASE);
  return createCallerFactory(portalRouter)({
    db,
    // biome-ignore lint/suspicious/noExplicitAny: a forged context for the caller
    session: teamSession as any,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers,
  });
}

async function newInvestor(
  label: string,
  holders: { companyId: string; stakeholderId: string }[],
): Promise<Investor> {
  const user = await db.portalUser.create({
    data: {
      email: `${EMAIL_PREFIX}${label}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "$2b$12$not-used-by-this-script",
      passwordSetAt: new Date(),
    },
  });
  portalUserIds.push(user.id);
  const access = new Map<string, string>();
  for (const h of holders) {
    const row = await db.portalAccess.create({
      data: {
        publicId: `pa_${randomUUID().replace(/-/g, "")}`,
        portalUserId: user.id,
        companyId: h.companyId,
        stakeholderId: h.stakeholderId,
        invitedById: "portal-documents-integration",
      },
    });
    access.set(h.stakeholderId, row.publicId);
  }
  const { token } = await createPortalSession(db, {
    portalUserId: user.id,
    ip: FACTS.ip,
    userAgent: FACTS.userAgent,
    now: new Date(),
  });
  return { userId: user.id, token, access };
}

function accessOf(u: Investor, h: Holder): string {
  const id = u.access.get(h.id);
  if (id === undefined) throw new Error(`no access for ${h.name}`);
  return id;
}

async function bucket(
  c: TestCompany,
  label: string,
  opts: { key?: string; tags?: string[]; mimeType?: string } = {},
) {
  const key =
    opts.key ??
    `${c.name}/generic-documents-${label}-${randomUUID().slice(0, 8)}.pdf`;
  const row = await db.bucket.create({
    data: {
      name: `${label}.pdf`,
      key,
      mimeType: opts.mimeType ?? "application/pdf",
      size: 1234,
      tags: opts.tags ?? ["generic"],
    },
  });
  bucketIds.push(row.id);
  return row;
}

async function document(
  c: TestCompany,
  label: string,
  bucketRow: { id: string; key: string },
  extra: {
    stakeholderId?: string;
    kind?: string;
    recordCategory?: "MEMBER_LIST" | "CONSENTS_AND_MINUTES";
    name?: string;
  } = {},
) {
  const row = await db.document.create({
    data: {
      companyId: c.id,
      publicId: generatePublicId(),
      name: extra.name ?? `${label}.pdf`,
      bucketId: bucketRow.id,
      stakeholderId: extra.stakeholderId ?? null,
      kind: extra.kind ?? null,
      recordCategory: extra.recordCategory ?? null,
    },
  });
  docs[label] = { id: row.id, publicId: row.publicId, key: bucketRow.key };
  return row;
}

async function customRoleMember(
  c: TestCompany,
  permissions: { subject: string; actions: string[] }[],
) {
  const base = await createAdmin(c);
  const role = await db.customRole.create({
    data: {
      companyId: c.id,
      name: `role-${randomUUID().slice(0, 6)}`,
      permissions,
    },
  });
  await db.member.update({
    where: {
      id: (base.session.user as unknown as { memberId: string }).memberId,
    },
    data: { role: "CUSTOM", customRoleId: role.id },
  });
  return base;
}

async function setup() {
  section("setup");
  c1 = await createCompany("one");
  c2 = await createCompany("two");
  A = await newMember(c1, "A Preferred");
  B = await newMember(c1, "B Preferred");
  C = await newMember(c1, "C Common");
  D = await newMember(c1, "D Prospect");
  E = await newMember(c1, "E Interest");
  F = await newMember(c2, "F Other");
  await subscribe(c1, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-10",
  });
  await subscribe(c1, B.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  await subscribe(c1, E.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  await issueCommon(c1, C.id, "100", "2026-11-11");
  setToday(realToday(c1));
  await db.stakeholder.update({
    where: { id: E.id },
    data: { memberStatus: "FINANCIAL_INTEREST_ONLY" },
  });
  const statuses = await db.stakeholder.findMany({
    where: { id: { in: [A.id, B.id, C.id, D.id] } },
    select: { id: true, memberStatus: true },
  });
  const statusOf = new Map(statuses.map((s) => [s.id, s.memberStatus]));
  check(
    "A, B and C are Members, D a prospect",
    statusOf.get(A.id) === "MEMBER" &&
      statusOf.get(B.id) === "MEMBER" &&
      statusOf.get(C.id) === "MEMBER" &&
      statusOf.get(D.id) === "PROSPECT",
    JSON.stringify([...statusOf.values()]),
  );

  admin1 = await createAdmin(c1);
  admin2 = await createAdmin(c2);
  reader = await customRoleMember(c1, [
    { subject: "portal", actions: ["read"] },
    { subject: "documents", actions: ["read"] },
  ]);
  outsider = await customRoleMember(c1, [
    { subject: "documents", actions: ["read", "create", "update", "delete"] },
  ]);
  team1 = teamCaller(admin1.context);
  team2 = teamCaller(admin2.context);
  actor1 = {
    companyId: c1.id,
    memberId: (admin1.session.user as unknown as { memberId: string }).memberId,
    userId: admin1.session.user.id,
    userName: "Integration",
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
  };

  U1 = await newInvestor("u1", [
    { companyId: c1.id, stakeholderId: A.id },
    { companyId: c2.id, stakeholderId: F.id },
  ]);
  U2 = await newInvestor("u2", [{ companyId: c1.id, stakeholderId: B.id }]);
  U3 = await newInvestor("u3", [{ companyId: c1.id, stakeholderId: C.id }]);

  // A real object in MinIO for the open test.
  const file = {
    name: "real-file.pdf",
    type: "application/pdf",
    size: FILE_BODY.length,
    arrayBuffer: () =>
      Promise.resolve(new TextEncoder().encode(FILE_BODY).buffer),
  } as unknown as File;
  const uploaded = await uploadFile(file, {
    identifier: c1.name,
    keyPrefix: "generic-documents",
  });
  objectKeys.push(uploaded.key);
  const realBucket = await db.bucket.create({
    data: {
      name: "real-file.pdf",
      key: uploaded.key,
      mimeType: "application/pdf",
      size: FILE_BODY.length,
      tags: ["generic"],
    },
  });
  bucketIds.push(realBucket.id);
  await document(c1, "real", realBucket, { name: "Quarterly letter" });

  await document(c1, "free", await bucket(c1, "free"));
  await document(c1, "preset", await bucket(c1, "preset"));
  await document(c1, "race", await bucket(c1, "race"));
  const w9Bucket = await bucket(c1, "w9", {
    key: `${c1.name}/w9-docs-a-${randomUUID().slice(0, 8)}.pdf`,
  });
  await document(c1, "w9A", w9Bucket, { stakeholderId: A.id, kind: "w9" });
  // An untied Document on the W-9's object (document.create accepts any
  // company bucket): bound to A through the file.
  await document(c1, "w9Alias", w9Bucket);
  await document(c1, "orphan", await bucket(c1, "orphan"), { kind: "w9" });
  const packetBucket = await bucket(c1, "packet", { tags: ["esign"] });
  await db.template.create({
    data: {
      publicId: generatePublicId(),
      name: "Subscription packet A",
      bucketId: packetBucket.id,
      uploaderId: actor1.memberId,
      companyId: c1.id,
      workflow: "SUBSCRIPTION",
      stakeholderId: A.id,
    },
  });
  await document(c1, "packetA", packetBucket);
  await document(
    c1,
    "resolution",
    await bucket(c1, "resolution", {
      key: `${c1.id}/resolutions-r-${randomUUID().slice(0, 8)}.pdf`,
      tags: ["resolution"],
    }),
    { recordCategory: "CONSENTS_AND_MINUTES" },
  );
  await document(c1, "exhibitA", await bucket(c1, "exhibit-a"), {
    recordCategory: "MEMBER_LIST",
    name: "Exhibit A 2026-11-14.pdf",
  });
  await document(
    c1,
    "foreignKey",
    await bucket(c1, "foreign-key", {
      key: `not-${c1.name}/generic-documents-x.pdf`,
    }),
  );
  // A K-1 file (private report attachment of A) and an untied Document on it.
  const k1Bucket = await bucket(c1, "k1");
  const report = await db.memberReport.create({
    data: {
      publicId: generatePublicId(),
      companyId: c1.id,
      type: "TAX_K1",
      title: "K-1 2026",
      authorId: actor1.memberId,
    },
  });
  await db.memberReportAttachment.create({
    data: {
      reportId: report.id,
      companyId: c1.id,
      kind: "K1",
      name: "K-1 A.pdf",
      bucketId: k1Bucket.id,
      stakeholderId: A.id,
    },
  });
  await document(c1, "k1Alias", k1Bucket);
  // A file filed on A's convertible note.
  const note = await db.convertibleNote.create({
    data: {
      publicId: "CN-01",
      capital: 1000,
      stakeholderId: A.id,
      companyId: c1.id,
      issueDate: new Date("2026-11-01"),
      boardApprovalDate: new Date("2026-11-01"),
    },
  });
  const noteDoc = await document(c1, "noteA", await bucket(c1, "note"));
  await db.document.update({
    where: { id: noteDoc.id },
    data: { convertibleNoteId: note.id },
  });
  await document(c2, "docF", await bucket(c2, "doc-f"));
  check("fixtures created", true);
}

/**
 * "POLICY" for an RBAC refusal (UNAUTHORIZED with the RBAC message, as
 * opposed to a missing session or a role that failed to load), else the code.
 */
async function policyOf(fn: () => Promise<unknown>): Promise<string> {
  const e = await errorOf(fn);
  if (e === null) return "OK";
  return e.code === "UNAUTHORIZED" &&
    /^(No matching permissions|Permission denied)/.test(e.message)
    ? "POLICY"
    : `${e.code}:${e.message}`;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  const e = await errorOf(fn);
  return e === null ? "OK" : (e.code ?? "?");
}

/** The exact error (code and message) of a refused portal call. */
async function failure(fn: () => Promise<unknown>): Promise<string> {
  const e = await errorOf(fn);
  return e === null ? "OK" : `${e.code}:${e.message}`;
}

async function listIds(u: Investor, h: Holder): Promise<string[]> {
  const list = seen(
    `list ${h.name}`,
    await portalCaller(u.token).documents.list({ access: accessOf(u, h) }),
  );
  return list.map((d) => d.id).sort();
}

function openUrl(u: Investor, h: Holder, documentId: string) {
  return portalCaller(u.token).documents.fileUrl({
    access: accessOf(u, h),
    documentId,
  });
}

const opens = (portalUserId: string) =>
  db.portalAccessLog.count({
    where: { portalUserId, event: "DOCUMENT_OPENED" },
  });

const grantCount = (documentId: string) =>
  db.portalDocumentGrant.count({ where: { documentId } });

// ---------------------------------------------------------------------------

async function rbacAndSessions() {
  section("1. RBAC and sessions");
  // `withAccessControl` answers a policy refusal with UNAUTHORIZED
  // (src/trpc/api/trpc.ts, `withAccessControlTrpcContext`), not FORBIDDEN.
  const read = teamCaller(reader.context);
  const none = teamCaller(outsider.context);
  const free = docs.free?.publicId ?? "";
  eq(
    "portal: read may see share options",
    await codeOf(() => read.shareOptions({ documentPublicIds: [free] })),
    "OK",
  );
  eq(
    "portal: read may read the access log",
    await codeOf(() => read.accessLog({})),
    "OK",
  );
  eq(
    "portal: read may not share",
    await policyOf(() =>
      read.shareDocuments({
        documentPublicIds: [free],
        stakeholderIds: [A.id],
      }),
    ),
    "POLICY",
  );
  eq(
    "portal: read may not unshare",
    await policyOf(() =>
      read.unshareDocument({ documentPublicId: free, stakeholderIds: [A.id] }),
    ),
    "POLICY",
  );
  for (const [label, run] of [
    ["shareOptions", () => none.shareOptions({ documentPublicIds: [free] })],
    [
      "shareDocuments",
      () =>
        none.shareDocuments({
          documentPublicIds: [free],
          stakeholderIds: [A.id],
        }),
    ],
    [
      "unshareDocument",
      () =>
        none.unshareDocument({
          documentPublicId: free,
          stakeholderIds: [A.id],
        }),
    ],
    ["accessLog", () => none.accessLog({})],
  ] as const) {
    eq(
      `a role without portal is refused ${label}`,
      await policyOf(run),
      "POLICY",
    );
  }
  eq(
    "nothing was shared by refused calls",
    await grantCount(docs.free?.id ?? ""),
    0,
  );

  // A portal session is not a team session, and the reverse.
  const portalOnly = teamCaller({
    db,
    // biome-ignore lint/suspicious/noExplicitAny: no team session
    session: null as any,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers: new Headers({ cookie: `${portalCookieName()}=${U1.token}` }),
  });
  eq(
    "a portal cookie alone cannot call portalAdmin",
    await codeOf(() => portalOnly.shareOptions({ documentPublicIds: [free] })),
    "UNAUTHORIZED",
  );
  eq(
    "a team session alone cannot call portal.documents.list",
    await codeOf(() =>
      portalCaller(null, admin1.session).documents.list({
        access: accessOf(U1, A),
      }),
    ),
    "UNAUTHORIZED",
  );
  eq(
    "a team session alone cannot call portal.documents.fileUrl",
    await codeOf(() =>
      portalCaller(null, admin1.session).documents.fileUrl({
        access: accessOf(U1, A),
        documentId: free,
      }),
    ),
    "UNAUTHORIZED",
  );
}

async function noShares() {
  section("2. no shares: every list is empty");
  for (const [u, h] of [
    [U1, A],
    [U2, B],
    [U3, C],
    [U1, F],
  ] as const) {
    eq(`${h.name} sees no document`, (await listIds(u, h)).length, 0);
  }
}

async function shareAndSee() {
  section("3. share with A and C: A and C see it, B does not");
  const free = docs.free;
  if (!free) throw new Error("fixture");
  const result = seen(
    "share free",
    await team1.shareDocuments({
      documentPublicIds: [free.publicId],
      stakeholderIds: [A.id, C.id],
    }),
  );
  eq("two rows created", result.added, 2);
  eq("rows stored", await grantCount(free.id), 2);
  check("A lists it", (await listIds(U1, A)).includes(free.publicId));
  check("C lists it", (await listIds(U3, C)).includes(free.publicId));
  check("B does not", !(await listIds(U2, B)).includes(free.publicId));
  const notFound = await failure(() => openUrl(U2, B, "no-such-document-id"));
  eq(
    "B's fileUrl with the shared id is the same NOT_FOUND as an unknown id",
    await failure(() => openUrl(U2, B, free.publicId)),
    notFound,
  );
  check(
    "that NOT_FOUND has no message",
    /^NOT_FOUND:(NOT_FOUND)?$/.test(notFound),
    notFound,
  );
  const audit = await db.audit.findMany({
    where: { companyId: c1.id, action: "portal.documents-shared" },
    select: { summary: true, target: true },
  });
  check(
    "one audit row naming A and C, no key",
    audit.length === 1 &&
      (audit[0]?.summary ?? "").includes(A.name) &&
      (audit[0]?.summary ?? "").includes(C.name) &&
      !JSON.stringify(audit).includes(free.key),
    JSON.stringify(audit),
  );
  const again = await team1.shareDocuments({
    documentPublicIds: [free.publicId],
    stakeholderIds: [A.id],
  });
  check(
    "sharing again adds nothing and writes no audit row",
    again.added === 0 &&
      again.alreadyShared === 1 &&
      (await db.audit.count({
        where: { companyId: c1.id, action: "portal.documents-shared" },
      })) === 1,
  );
}

async function presetsFrozen() {
  section("4. a preset is a frozen list; a later Member is reported missing");
  const preset = docs.preset;
  if (!preset) throw new Error("fixture");
  const options = seen(
    "shareOptions preset",
    await team1.shareOptions({ documentPublicIds: [preset.publicId] }),
  );
  const all = options.presets.find((p) => p.key === "ALL_CURRENT_MEMBERS");
  const preferred = options.presets.find((p) => p.key === "PREFERRED_MEMBERS");
  eq(
    "all current Members = A, B, C",
    JSON.stringify([...(all?.stakeholderIds ?? [])].sort()),
    JSON.stringify([A.id, B.id, C.id].sort()),
  );
  eq(
    "Preferred Members = A, B",
    JSON.stringify([...(preferred?.stakeholderIds ?? [])].sort()),
    JSON.stringify([A.id, B.id].sort()),
  );
  check(
    "the prospect and the FIO holder are listed but in no preset",
    options.holders.some((h) => h.stakeholderId === D.id) &&
      options.holders.some((h) => h.stakeholderId === E.id) &&
      options.presets.every(
        (p) =>
          !p.stakeholderIds.includes(D.id) && !p.stakeholderIds.includes(E.id),
      ),
  );
  await team1.shareDocuments({
    documentPublicIds: [preset.publicId],
    stakeholderIds: all?.stakeholderIds ?? [],
  });
  eq("one row per current Member of that day", await grantCount(preset.id), 3);

  // G is admitted afterwards.
  G = await newMember(c1, "G Later");
  await subscribe(c1, G.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-12",
  });
  setToday(realToday(c1));
  U4 = await newInvestor("u4", [{ companyId: c1.id, stakeholderId: G.id }]);
  check(
    "G does not see the document",
    !(await listIds(U4, G)).includes(preset.publicId),
  );
  eq(
    "G's fileUrl is NOT_FOUND",
    await codeOf(() => openUrl(U4, G, preset.publicId)),
    "NOT_FOUND",
  );
  const after = seen(
    "shareOptions after G",
    await team1.shareOptions({ documentPublicIds: [preset.publicId] }),
  );
  const row = after.documents[0];
  eq(
    "shareOptions reports the missing Member",
    row?.missingCurrentMembers.message,
    "1 current Member is not on this list",
  );
  eq(
    "and names G",
    JSON.stringify(row?.missingCurrentMembers.stakeholderIds),
    JSON.stringify([G.id]),
  );
  await team1.shareDocuments({
    documentPublicIds: [preset.publicId],
    stakeholderIds: [G.id],
  });
  check(
    "after adding G, G sees it",
    (await listIds(U4, G)).includes(preset.publicId),
  );
  eq(
    "a prospect may be selected by hand",
    await codeOf(() =>
      team1.shareDocuments({
        documentPublicIds: [preset.publicId],
        stakeholderIds: [D.id],
      }),
    ),
    "OK",
  );
}

async function holderBound() {
  section("5. holder-bound files: only their holder, all-or-nothing");
  const { w9A, w9Alias, orphan, packetA, free, resolution, exhibitA } = docs;
  if (
    !w9A ||
    !w9Alias ||
    !orphan ||
    !packetA ||
    !free ||
    !resolution ||
    !exhibitA
  )
    throw new Error("fixture");
  const options = seen(
    "shareOptions bound",
    await team1.shareOptions({
      documentPublicIds: [
        w9A.publicId,
        w9Alias.publicId,
        orphan.publicId,
        packetA.publicId,
        resolution.publicId,
        exhibitA.publicId,
        free.publicId,
      ],
    }),
  );
  const by = new Map(options.documents.map((d) => [d.documentPublicId, d]));
  const sh = (id: string) => JSON.stringify(by.get(id)?.shareability);
  eq(
    "the W-9 is HOLDER_ONLY A",
    sh(w9A.publicId),
    JSON.stringify({
      kind: "HOLDER_ONLY",
      stakeholderId: A.id,
      holderName: A.name,
    }),
  );
  eq(
    "an untied Document on the W-9's file is HOLDER_ONLY A",
    sh(w9Alias.publicId),
    sh(w9A.publicId),
  );
  eq(
    "the subscription packet's file is HOLDER_ONLY A",
    sh(packetA.publicId),
    sh(w9A.publicId),
  );
  eq(
    "a W-9 whose holder was removed can be shared with nobody",
    sh(orphan.publicId),
    JSON.stringify({ kind: "NONE", reason: "HOLDER_REMOVED" }),
  );
  eq(
    "a plain upload is ANY",
    sh(free.publicId),
    JSON.stringify({ kind: "ANY" }),
  );
  eq(
    "the executed resolution carries the warning",
    by
      .get(resolution.publicId)
      ?.warnings.map((w) => w.code)
      .join(","),
    "RESOLUTION",
  );
  eq(
    "the Exhibit A carries the warning",
    by
      .get(exhibitA.publicId)
      ?.warnings.map((w) => w.code)
      .join(","),
    "MEMBER_LIST",
  );
  eq("a plain upload carries none", by.get(free.publicId)?.warnings.length, 0);
  const { k1Alias, noteA } = docs;
  if (!k1Alias || !noteA) throw new Error("fixture");
  const more = await team1.shareOptions({
    documentPublicIds: [k1Alias.publicId, noteA.publicId],
  });
  for (const d of more.documents) {
    eq(
      `${d.name}: ${d.source === "SECURITY_FILE" ? "a convertible note file" : "a Document on A's K-1 object"} is HOLDER_ONLY A`,
      JSON.stringify(d.shareability),
      sh(w9A.publicId),
    );
  }

  const before = await db.portalDocumentGrant.count({
    where: { companyId: c1.id },
  });
  const refused = await errorOf(() =>
    team1.shareDocuments({
      documentPublicIds: [free.publicId, w9A.publicId],
      stakeholderIds: [B.id],
    }),
  );
  check(
    "sharing A's W-9 with B is BAD_REQUEST naming the rule",
    refused?.code === "BAD_REQUEST" &&
      /can be shared only with that holder/.test(refused.message),
    JSON.stringify(refused),
  );
  for (const [label, id] of [
    ["the alias", w9Alias.publicId],
    ["the packet file", packetA.publicId],
    ["the orphaned W-9 (even with A)", orphan.publicId],
    ["the K-1 alias", k1Alias.publicId],
    ["the convertible note file", noteA.publicId],
  ] as const) {
    eq(
      `sharing ${label} with B is refused`,
      await codeOf(() =>
        team1.shareDocuments({
          documentPublicIds: [id],
          stakeholderIds: label.startsWith("the orphaned") ? [A.id] : [B.id],
        }),
      ),
      "BAD_REQUEST",
    );
  }
  eq(
    "nothing was written by the refused shares (free was not shared with B either)",
    await db.portalDocumentGrant.count({ where: { companyId: c1.id } }),
    before,
  );
  await team1.shareDocuments({
    documentPublicIds: [w9A.publicId],
    stakeholderIds: [A.id],
  });
  check("A sees its own W-9", (await listIds(U1, A)).includes(w9A.publicId));

  // A hand-inserted grant for the wrong holder is ignored at read.
  await db.portalDocumentGrant.createMany({
    data: [
      {
        companyId: c1.id,
        documentId: w9A.id,
        stakeholderId: B.id,
        grantedById: "hand-inserted",
      },
      {
        companyId: c1.id,
        documentId: w9Alias.id,
        stakeholderId: B.id,
        grantedById: "hand-inserted",
      },
    ],
  });
  const bList = await listIds(U2, B);
  check(
    "B's list ignores the hand-inserted W-9 grants",
    !bList.includes(w9A.publicId) && !bList.includes(w9Alias.publicId),
    JSON.stringify(bList),
  );
  eq(
    "B's fileUrl for the W-9 is NOT_FOUND",
    await codeOf(() => openUrl(U2, B, w9A.publicId)),
    "NOT_FOUND",
  );
}

async function holderDeleted() {
  section("5b. a holder is deleted: its files can be shared with nobody");
  const H = await newMember(c1, "H Leaving");
  const w9 = await document(c1, "w9H", await bucket(c1, "w9-h"), {
    stakeholderId: H.id,
    kind: "w9",
  });
  const packetBucket = await bucket(c1, "packet-h", { tags: ["esign"] });
  const envelope = await db.template.create({
    data: {
      publicId: generatePublicId(),
      name: "Subscription packet H",
      bucketId: packetBucket.id,
      uploaderId: actor1.memberId,
      companyId: c1.id,
      workflow: "SUBSCRIPTION",
      stakeholderId: H.id,
    },
  });
  const packet = await document(c1, "packetH", packetBucket);
  await team1.shareDocuments({
    documentPublicIds: [w9.publicId],
    stakeholderIds: [H.id],
  });
  await db.stakeholder.delete({ where: { id: H.id } });
  const after = await db.document.findUnique({
    where: { id: w9.id },
    select: { stakeholderId: true },
  });
  const envAfter = await db.template.findUnique({
    where: { id: envelope.id },
    select: { stakeholderId: true },
  });
  check(
    "deleting the holder cleared Document and Template holder columns",
    after?.stakeholderId === null && envAfter?.stakeholderId === null,
    JSON.stringify([after, envAfter]),
  );
  const options = await team1.shareOptions({
    documentPublicIds: [w9.publicId, packet.publicId],
  });
  for (const d of options.documents) {
    eq(
      `${d.name} is NONE / HOLDER_REMOVED`,
      JSON.stringify(d.shareability),
      JSON.stringify({ kind: "NONE", reason: "HOLDER_REMOVED" }),
    );
  }
  const refused = await errorOf(() =>
    team1.shareDocuments({
      documentPublicIds: [w9.publicId],
      stakeholderIds: [A.id],
    }),
  );
  check(
    "sharing the deleted holder's W-9 with A is refused",
    refused?.code === "BAD_REQUEST" &&
      /holder that no longer exists/.test(refused.message),
    JSON.stringify(refused),
  );
  eq(
    "and with A, the packet file too",
    await codeOf(() =>
      team1.shareDocuments({
        documentPublicIds: [packet.publicId],
        stakeholderIds: [A.id],
      }),
    ),
    "BAD_REQUEST",
  );
  const left = await team1.shareOptions({ documentPublicIds: [w9.publicId] });
  eq(
    "the deleted holder's leftover grant is listed without a name",
    JSON.stringify(left.documents[0]?.sharedWith.map((s) => s.name)),
    "[null]",
  );
  eq(
    "and can be removed",
    (
      await team1.unshareDocument({
        documentPublicId: w9.publicId,
        stakeholderIds: [H.id],
      })
    ).removed,
    1,
  );
}

async function crossCompany() {
  section("6. cross-company isolation, both sides");
  const { docF, free, foreignKey } = docs;
  if (!docF || !free || !foreignKey) throw new Error("fixture");
  await team2.shareDocuments({
    documentPublicIds: [docF.publicId],
    stakeholderIds: [F.id],
  });
  eq(
    "F sees only its company's document",
    JSON.stringify(await listIds(U1, F)),
    JSON.stringify([docF.publicId]),
  );
  for (const [label, run] of [
    [
      "share company 2's document",
      () =>
        team1.shareDocuments({
          documentPublicIds: [docF.publicId],
          stakeholderIds: [A.id],
        }),
    ],
    [
      "share with company 2's holder",
      () =>
        team1.shareDocuments({
          documentPublicIds: [free.publicId],
          stakeholderIds: [F.id],
        }),
    ],
    [
      "unshare company 2's document",
      () =>
        team1.unshareDocument({
          documentPublicId: docF.publicId,
          stakeholderIds: [F.id],
        }),
    ],
    [
      "read share options of company 2's document",
      () => team1.shareOptions({ documentPublicIds: [docF.publicId] }),
    ],
    [
      "company 2 reads company 1's document",
      () => team2.shareOptions({ documentPublicIds: [free.publicId] }),
    ],
  ] as const) {
    const e = await errorOf(run);
    check(
      `team: ${label} is NOT_FOUND without naming it`,
      e?.code === "NOT_FOUND" &&
        !e.message.includes(docF.publicId) &&
        !e.message.includes(F.id),
      JSON.stringify(e),
    );
  }
  eq("F's grant is untouched", await grantCount(docF.id), 1);
  const notFound = await failure(() => openUrl(U1, A, "no-such-document-id"));
  for (const [label, run] of [
    ["A opens F's document by public id", () => openUrl(U1, A, docF.publicId)],
    ["A opens F's document by internal id", () => openUrl(U1, A, docF.id)],
    [
      "A opens its own shared document by internal id",
      () => openUrl(U1, A, free.id),
    ],
    ["F opens company 1's document", () => openUrl(U1, F, free.publicId)],
  ] as const) {
    eq(
      `investor: ${label} is the same NOT_FOUND`,
      await failure(run),
      notFound,
    );
  }
  // A grant row whose company disagrees with the document's is ignored.
  await db.portalDocumentGrant.create({
    data: {
      companyId: c2.id,
      documentId: free.id,
      stakeholderId: F.id,
      grantedById: "hand-inserted",
    },
  });
  check(
    "F's list ignores a grant of company 1's document stored under company 2",
    !(await listIds(U1, F)).includes(free.publicId),
  );
  eq(
    "and F cannot open it",
    await failure(() => openUrl(U1, F, free.publicId)),
    notFound,
  );
  // A key outside the company namespace is never listed or opened.
  await db.portalDocumentGrant.create({
    data: {
      companyId: c1.id,
      documentId: foreignKey.id,
      stakeholderId: A.id,
      grantedById: "hand-inserted",
    },
  });
  check(
    "a document whose key is outside the namespace is not listed",
    !(await listIds(U1, A)).includes(foreignKey.publicId),
  );
  eq(
    "nor opened",
    await failure(() => openUrl(U1, A, foreignKey.publicId)),
    notFound,
  );
}

async function concurrentShare() {
  section("7. concurrent duplicate share");
  const doc = docs.race;
  if (!doc) throw new Error("fixture");
  const r = await race(
    (tx) =>
      shareDocumentsInTx(tx, actor1, {
        documentPublicIds: [doc.publicId],
        stakeholderIds: [A.id],
      }),
    (tx) =>
      shareDocumentsInTx(tx, actor1, {
        documentPublicIds: [doc.publicId],
        stakeholderIds: [A.id],
      }),
  );
  check(
    "the second share waited for the first (document lock)",
    r.secondWaited,
  );
  check("different connections", r.pids[0] !== r.pids[1]);
  const added = [r.first, r.second].map((o) => (o.ok ? o.value.added : -1));
  eq(
    "exactly one of them added the row",
    JSON.stringify(added.sort()),
    "[0,1]",
  );
  eq("one grant row", await grantCount(doc.id), 1);
  const audits = await db.audit.findMany({
    where: { companyId: c1.id, action: "portal.documents-shared" },
    select: { target: true },
  });
  eq(
    "one audit row names this document",
    audits.filter((a) => JSON.stringify(a.target).includes(doc.id)).length,
    1,
  );
  // Through the procedure, twice at once.
  const both = await Promise.all([
    team1.shareDocuments({
      documentPublicIds: [doc.publicId],
      stakeholderIds: [B.id],
    }),
    team1.shareDocuments({
      documentPublicIds: [doc.publicId],
      stakeholderIds: [B.id],
    }),
  ]);
  eq(
    "two concurrent procedure calls add one row",
    both
      .map((b) => b.added)
      .sort()
      .join(","),
    "0,1",
  );
  eq("two grant rows in total", await grantCount(doc.id), 2);
}

async function openRealFile() {
  section("8. open a real file: 60-second URL, log row, revoke");
  const real = docs.real;
  if (!real) throw new Error("fixture");
  await team1.shareDocuments({
    documentPublicIds: [real.publicId],
    stakeholderIds: [A.id],
  });
  const list = await portalCaller(U1.token).documents.list({
    access: accessOf(U1, A),
  });
  const item = list.find((d) => d.id === real.publicId);
  eq(
    "the list item has exactly the planned fields",
    JSON.stringify(Object.keys(item ?? {}).sort()),
    JSON.stringify([
      "category",
      "id",
      "inline",
      "name",
      "sharedAt",
      "sizeBytes",
    ]),
  );
  check("a PDF opens inline", item?.inline === true);
  const opensBefore = await opens(U1.userId);
  const res = await openUrl(U1, A, real.publicId);
  eq(
    "fileUrl returns only url and expiresInSeconds",
    JSON.stringify(Object.keys(res).sort()),
    JSON.stringify(["expiresInSeconds", "url"]),
  );
  seen("fileUrl minus url", { ...res, url: undefined });
  eq("expiresInSeconds is 60", res.expiresInSeconds, 60);
  const url = new URL(res.url);
  eq(
    "the signature's lifetime is 60 seconds",
    url.searchParams.get("X-Amz-Expires"),
    "60",
  );
  check(
    "the key appears only inside the signed URL's path",
    url.pathname.endsWith(real.key) ||
      url.pathname.includes(encodeURI(real.key)),
    url.pathname,
  );
  const body = await (await fetch(res.url)).text();
  eq("the URL serves the uploaded object", body, FILE_BODY);
  eq("one DOCUMENT_OPENED row", (await opens(U1.userId)) - opensBefore, 1);
  const log = await db.portalAccessLog.findFirst({
    where: { portalUserId: U1.userId, event: "DOCUMENT_OPENED" },
    orderBy: { createdAt: "desc" },
  });
  check(
    "the row names holder, company, document, address and agent",
    log?.companyId === c1.id &&
      log.stakeholderId === A.id &&
      log.portalAccessId !== null &&
      log.targetType === "document" &&
      log.targetId === real.id &&
      log.targetName === "Quarterly letter" &&
      log.ip === FACTS.ip &&
      log.userAgent === FACTS.userAgent,
    JSON.stringify(log),
  );
  check(
    "no log column holds the key or the URL",
    !JSON.stringify(log).includes(real.key) &&
      !JSON.stringify(log).includes("X-Amz"),
  );
  const refusedBefore = await opens(U2.userId);
  await errorOf(() => openUrl(U2, B, real.publicId));
  eq(
    "a refused open writes no row",
    (await opens(U2.userId)) - refusedBefore,
    0,
  );

  // Revoke: the next request is refused.
  const removed = seen(
    "unshare",
    await team1.unshareDocument({
      documentPublicId: real.publicId,
      stakeholderIds: [A.id, B.id],
    }),
  );
  eq(
    "unshare removed exactly A's row",
    JSON.stringify(removed.removedStakeholderIds),
    JSON.stringify([A.id]),
  );
  check(
    "after revoke A's list drops it",
    !(await listIds(U1, A)).includes(real.publicId),
  );
  eq(
    "after revoke A's fileUrl is NOT_FOUND",
    await codeOf(() => openUrl(U1, A, real.publicId)),
    "NOT_FOUND",
  );
  // Section 5b also unshares (w9H); select this document's row.
  const unshareAudit = await db.audit.findFirst({
    where: {
      companyId: c1.id,
      action: "portal.document-unshared",
      summary: { contains: '"Quarterly letter"' },
    },
    select: { summary: true },
  });
  check(
    "the unshare audit row names A",
    (unshareAudit?.summary ?? "").includes(A.name),
    unshareAudit?.summary ?? "",
  );
  eq(
    "unsharing again removes nothing and writes no audit row",
    (
      await team1.unshareDocument({
        documentPublicId: real.publicId,
        stakeholderIds: [A.id],
      })
    ).removed,
    0,
  );

  // The URL issued before the revoke expires after 60 seconds.
  console.log("  …   waiting 62 s for the signed URL to expire");
  await new Promise((r) => setTimeout(r, 62_000));
  const late = await fetch(res.url);
  eq("the URL is refused by storage after 60 seconds", late.status, 403);
}

async function disabledAccess() {
  section("9. disabled access");
  const free = docs.free;
  if (!free) throw new Error("fixture");
  await db.portalAccess.update({
    where: { publicId: accessOf(U1, A) },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  eq(
    "A's list through a disabled access is NOT_FOUND",
    await codeOf(() =>
      portalCaller(U1.token).documents.list({ access: accessOf(U1, A) }),
    ),
    "NOT_FOUND",
  );
  eq(
    "A's fileUrl through a disabled access is NOT_FOUND",
    await codeOf(() => openUrl(U1, A, free.publicId)),
    "NOT_FOUND",
  );
  eq(
    "the same user's access to F still works",
    await codeOf(() =>
      portalCaller(U1.token).documents.list({ access: accessOf(U1, F) }),
    ),
    "OK",
  );
  eq(
    "user 2 cannot use A's access id",
    await codeOf(() =>
      portalCaller(U2.token).documents.list({ access: accessOf(U1, A) }),
    ),
    "NOT_FOUND",
  );
  await db.portalAccess.update({
    where: { publicId: accessOf(U1, A) },
    data: { status: "ACTIVE", disabledAt: null },
  });
}

async function accessLog() {
  section("10. the access log");
  // An account event (no company) of user 1 and of user 2.
  await writePortalLog(
    db,
    { portalUser: { id: U1.userId }, ...LOG_FACTS },
    {
      event: "SIGNED_IN",
    },
  );
  await writePortalLog(
    db,
    { portalUser: { id: U2.userId }, ...LOG_FACTS },
    {
      event: "SIGNED_IN",
    },
  );
  const page = seen("accessLog c1", await team1.accessLog({}));
  check(
    "company 1 sees its open with holder name and email",
    page.rows.some(
      (r) =>
        r.event === "DOCUMENT_OPENED" &&
        r.holder?.name === A.name &&
        (r.portalUserEmail ?? "").startsWith(`${EMAIL_PREFIX}u1.`) &&
        r.target?.id === docs.real?.id,
    ),
  );
  check(
    "and the sign-ins of its investors",
    page.rows.filter((r) => r.event === "SIGNED_IN" && !r.companyScoped)
      .length === 2,
  );
  const p2 = seen("accessLog c2", await team2.accessLog({}));
  check(
    "company 2 sees user 1's sign-in but none of company 1's rows",
    p2.rows.every((r) => r.event === "SIGNED_IN") &&
      p2.rows.length === 1 &&
      (p2.rows[0]?.portalUserEmail ?? "").startsWith(`${EMAIL_PREFIX}u1.`),
    JSON.stringify(p2.rows.map((r) => r.event)),
  );
  const byB = await team1.accessLog({ stakeholderId: B.id });
  check(
    "filtered by B: only B's user",
    byB.rows.length > 0 &&
      byB.rows.every((r) =>
        (r.portalUserEmail ?? "").startsWith(`${EMAIL_PREFIX}u2.`),
      ),
  );
  eq(
    "filtered by company 2's holder: nothing",
    (await team1.accessLog({ stakeholderId: F.id })).rows.length,
    0,
  );
  eq(
    "filtered by the real document's id: its one open",
    (await team1.accessLog({ targetType: "document", targetId: docs.real?.id }))
      .rows.length,
    1,
  );
  eq(
    "filtered by its public id: the same open",
    (await team1.accessLog({ documentPublicId: docs.real?.publicId })).rows
      .length,
    1,
  );
  eq(
    "filtered by company 2's document: nothing",
    (await team1.accessLog({ documentPublicId: docs.docF?.publicId })).rows
      .length,
    0,
  );

  // Paging: 60 more rows.
  for (let i = 0; i < 60; i++) {
    await writePortalLog(
      db,
      {
        portalUser: { id: U3.userId },
        ...LOG_FACTS,
        holder: {
          accessId: "x",
          stakeholderId: C.id,
          companyId: c1.id,
        },
      },
      { event: "REPORT_VIEWED", targetType: "memberReport", targetId: `r${i}` },
    );
  }
  const total = await db.portalAccessLog.count({
    where: {
      OR: [
        { companyId: c1.id },
        {
          companyId: null,
          portalUserId: { in: [U1.userId, U2.userId, U3.userId, U4.userId] },
        },
      ],
    },
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 10; n++) {
    const p = await team1.accessLog(cursor ? { cursor } : {});
    ids.push(...p.rows.map((r) => r.id));
    if (n === 0) eq("a page holds 50 rows", p.rows.length, 50);
    if (p.nextCursor === null) break;
    cursor = p.nextCursor;
  }
  eq("paging returns every row once", new Set(ids).size, total);
  eq("and no row twice", ids.length, total);
  eq(
    "a malformed cursor is BAD_REQUEST",
    await codeOf(() => team1.accessLog({ cursor: "not a cursor" })),
    "BAD_REQUEST",
  );
}

async function notifications() {
  section("10b. P10: the 'new documents' email");
  const n = (await db.portalNotification.count({
    where: { companyId: { in: [c1.id, c2.id] } },
  })) as number;
  eq("default off: no share so far wrote a notification row", n, 0);
  eq("and queued no job", notifyJobs.length, 0);

  // People: UM has A and B; UD a DISABLED access to C; UP no password, access
  // to C; UE has E, which will already have every document.
  const UM = await newInvestor("um", [
    { companyId: c1.id, stakeholderId: A.id },
    { companyId: c1.id, stakeholderId: B.id },
  ]);
  const UD = await newInvestor("ud", [
    { companyId: c1.id, stakeholderId: C.id },
  ]);
  await db.portalAccess.update({
    where: { publicId: accessOf(UD, C) },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  const UE = await newInvestor("ue", [
    { companyId: c1.id, stakeholderId: E.id },
  ]);
  const up = await db.portalUser.create({
    data: {
      email: `${EMAIL_PREFIX}up.${randomUUID().slice(0, 8)}@example.com`,
    },
  });
  portalUserIds.push(up.id);
  await db.portalAccess.create({
    data: {
      publicId: `pa_${randomUUID().replace(/-/g, "")}`,
      portalUserId: up.id,
      companyId: c1.id,
      stakeholderId: C.id,
      invitedById: "portal-documents-integration",
    },
  });

  const names: string[] = [];
  const twenty: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const label = `notify${String(i).padStart(2, "0")}`;
    const name = `Notify secret file ${String(i).padStart(2, "0")}.pdf`;
    names.push(name);
    const d = await document(c1, label, await bucket(c1, label), { name });
    twenty.push(d.publicId);
  }
  const pre = seen(
    "pre-share without notify",
    await team1.shareDocuments({
      documentPublicIds: twenty,
      stakeholderIds: [E.id],
    }),
  );
  const preA = await team1.shareDocuments({
    documentPublicIds: [twenty[0] as string],
    stakeholderIds: [A.id],
    notify: false,
  });
  check(
    "shares without notify queue nothing",
    pre.notificationsQueued === 0 &&
      preA.notificationsQueued === 0 &&
      notifyJobs.length === 0 &&
      (await db.portalNotification.count({ where: { companyId: c1.id } })) ===
        0,
  );

  // Mail guard on the procedure: production with the catcher refuses before
  // any write.
  const grantsBefore = await db.portalDocumentGrant.count({
    where: { companyId: c1.id },
  });
  const savedNodeEnv = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  let guarded: string;
  try {
    guarded = await failure(() =>
      team1.shareDocuments({
        documentPublicIds: twenty,
        stakeholderIds: [A.id, B.id, C.id, E.id],
        notify: true,
      }),
    );
  } finally {
    Object.assign(process.env, { NODE_ENV: savedNodeEnv });
  }
  check(
    "production with the mail catcher: notify is BAD_REQUEST",
    guarded.startsWith("BAD_REQUEST"),
    guarded,
  );
  check(
    "and nothing was written or queued",
    (await db.portalDocumentGrant.count({ where: { companyId: c1.id } })) ===
      grantsBefore &&
      (await db.portalNotification.count({ where: { companyId: c1.id } })) ===
        0 &&
      notifyJobs.length === 0,
  );
  check(
    "the same share without notify is not blocked by mail",
    await (async () => {
      const guardDoc = await document(
        c1,
        "notifyGuard",
        await bucket(c1, "notify-guard"),
      );
      Object.assign(process.env, { NODE_ENV: "production" });
      try {
        const r = await team1.shareDocuments({
          documentPublicIds: [guardDoc.publicId],
          stakeholderIds: [D.id],
          notify: false,
        });
        return r.added === 1 && r.notificationsQueued === 0;
      } finally {
        Object.assign(process.env, { NODE_ENV: savedNodeEnv });
      }
    })(),
  );

  // The share: 20 documents with A, B, C, E, notify ticked.
  const shared = seen(
    "share twenty with notify",
    await team1.shareDocuments({
      documentPublicIds: twenty,
      stakeholderIds: [A.id, B.id, C.id, E.id],
      notify: true,
    }),
  );
  eq("rows added (A 19, B 20, C 20, E 0)", shared.added, 59);
  const rows = await db.portalNotification.findMany({
    where: { companyId: c1.id },
    select: {
      id: true,
      portalUserId: true,
      kind: true,
      batchKey: true,
      subjectLine: true,
      claimedAt: true,
    },
  });
  const expectedUsers = [U1.userId, U2.userId, U3.userId, UM.userId].sort();
  eq(
    "one row per person with ACTIVE, password-set access to a holder that gained",
    JSON.stringify(rows.map((r) => r.portalUserId).sort()),
    JSON.stringify(expectedUsers),
  );
  eq("notificationsQueued is that count", shared.notificationsQueued, 4);
  check(
    "no row for the disabled, the password-less, or the already-had-all person",
    !rows.some((r) => [UD.userId, up.id, UE.userId].includes(r.portalUserId)),
  );
  check(
    "one batch key, kind and company subject, none claimed",
    new Set(rows.map((r) => r.batchKey)).size === 1 &&
      rows.every(
        (r) =>
          r.kind === "portal.documents-shared" &&
          r.subjectLine === `New documents in the ${c1.name} investor portal` &&
          r.claimedAt === null,
      ),
    JSON.stringify(rows),
  );
  eq("one job per row", notifyJobs.length, 4);
  const jobOf = (userId: string) => {
    const row = rows.find((r) => r.portalUserId === userId);
    const job = notifyJobs.find((j) => j.data.notificationId === row?.id);
    if (!row || !job) throw new Error(`no job for ${userId}`);
    return job;
  };
  const umJob = jobOf(UM.userId);
  eq(
    "the two-holder person's job names A (19 documents) and B (20)",
    JSON.stringify(
      umJob.data.holders.map((h) => [
        h.stakeholderId,
        h.documentPublicIds.length,
      ]),
    ),
    JSON.stringify(
      [
        [A.id, 19],
        [B.id, 20],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    ),
  );
  check(
    "jobs carry ids only and one singleton key per row",
    notifyJobs.every((j) => {
      const keys = Object.keys(j.data).sort().join(",");
      const opt = j.options as { singletonKey?: string };
      return (
        keys === "holders,notificationId" &&
        opt.singletonKey === `portal-notification-${j.data.notificationId}` &&
        !JSON.stringify(j.data).includes("@") &&
        !names.some((nm) => JSON.stringify(j.data).includes(nm))
      );
    }),
  );

  // Exactly once: two concurrent runs, then a third.
  const sent: { to: string; subject: string; html: string; log: unknown }[] =
    [];
  const slowCapture: PortalNotificationDeps = {
    now: () => new Date(),
    send: async (options, logContext) => {
      await new Promise((r) => setTimeout(r, 300));
      sent.push({
        to: String(options.to),
        subject: String(options.subject),
        html: String(options.html),
        log: logContext,
      });
      return { emailLogId: null, sentAt: new Date(), messageId: null };
    },
  };
  // `now` is called once per claim attempt and once for the winner's sentAt:
  // 3 calls prove both runs reached the guarded UPDATE (the loser was turned
  // away by it, not by the earlier read).
  let nowCalls = 0;
  const counting: PortalNotificationDeps = {
    ...slowCapture,
    now: () => {
      nowCalls++;
      return new Date();
    },
  };
  const [r1, r2] = await Promise.all([
    deliverPortalNotification(umJob.data, counting),
    deliverPortalNotification(umJob.data, counting),
  ]);
  eq("both concurrent runs reached the guarded claim", nowCalls, 3);
  eq(
    "two concurrent runs: one SENT, one ALREADY_CLAIMED",
    [r1, r2].sort().join(","),
    "ALREADY_CLAIMED,SENT",
  );
  eq("one email left", sent.length, 1);
  eq(
    "a third run sends nothing",
    await deliverPortalNotification(umJob.data, slowCapture),
    "ALREADY_CLAIMED",
  );
  eq("still one email", sent.length, 1);
  const um = sent[0];
  const umUser = await db.portalUser.findUniqueOrThrow({
    where: { id: UM.userId },
  });
  check("to the person's address", um?.to === umUser.email, um?.to);
  const html = um?.html ?? "";
  check(
    "names both of the person's holders with their counts",
    html.includes(A.name) &&
      html.includes(B.name) &&
      html.includes("19 new documents") &&
      html.includes("20 new documents"),
  );
  const buckets = await db.bucket.findMany({
    where: { id: { in: bucketIds } },
    select: { id: true, key: true },
  });
  const forbidden = [
    C.name,
    E.name,
    F.name,
    ...names,
    ...twenty,
    ...buckets.flatMap((b) => [b.id, b.key]),
    "set-password",
    "/member-reports/",
    "token",
  ];
  eq(
    "no other holder's name, document name or id, file, key or token",
    JSON.stringify(
      forbidden.filter(
        (f) => html.includes(f) || (um?.subject ?? "").includes(f),
      ),
    ),
    "[]",
  );
  check(
    "no attachment, and the link is the plain sign-in page (several holders)",
    !("attachments" in (um ?? {})) &&
      html.includes(`${BASE}/portal/sign-in"`) &&
      !html.includes("next="),
  );
  check(
    "logged on the lowest holder id of the two, with company and row",
    JSON.stringify(um?.log) ===
      JSON.stringify({
        kind: "portal.documents-shared",
        companyId: c1.id,
        stakeholderId: [A.id, B.id].sort()[0],
        relatedType: "portalNotification",
        relatedId: umJob.data.notificationId,
      }),
    JSON.stringify(um?.log),
  );

  // Mail guard in the job: nothing claimed, nothing sent.
  const u2Job = jobOf(U2.userId);
  Object.assign(process.env, { NODE_ENV: "production" });
  let blocked: string;
  try {
    blocked = await deliverPortalNotification(u2Job.data, slowCapture);
  } finally {
    Object.assign(process.env, { NODE_ENV: savedNodeEnv });
  }
  eq(
    "job in production with the mail catcher: MAIL_BLOCKED",
    blocked,
    "MAIL_BLOCKED",
  );
  check(
    "and the row is not claimed, nothing sent",
    (
      await db.portalNotification.findUniqueOrThrow({
        where: { id: u2Job.data.notificationId },
      })
    ).claimedAt === null && sent.length === 1,
  );
  eq(
    "once mail is deliverable the same job sends",
    await deliverPortalNotification(u2Job.data, slowCapture),
    "SENT",
  );

  // Send-time re-check: C's access disabled after the share.
  const u3Job = jobOf(U3.userId);
  await db.portalAccess.update({
    where: { publicId: accessOf(U3, C) },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  eq(
    "access disabled before the job ran: nothing sent",
    await deliverPortalNotification(u3Job.data, slowCapture),
    "NOTHING_TO_SEND",
  );
  await db.portalAccess.update({
    where: { publicId: accessOf(U3, C) },
    data: { status: "ACTIVE", disabledAt: null },
  });
  eq("still two emails", sent.length, 2);

  // A failed send releases the claim, so pg-boss's retry sends.
  const failing: PortalNotificationDeps = {
    now: () => new Date(),
    send: () => Promise.reject(new Error("SMTP down")),
  };
  eq(
    "a failed send rejects (pg-boss retries)",
    (
      await failure(() => deliverPortalNotification(u3Job.data, failing))
    ).endsWith("SMTP down"),
    true,
  );
  check(
    "and leaves the row unclaimed and unsent",
    await (async () => {
      const r = await db.portalNotification.findUniqueOrThrow({
        where: { id: u3Job.data.notificationId },
      });
      return r.claimedAt === null && r.sentAt === null;
    })(),
  );
  eq(
    "the retry sends",
    await deliverPortalNotification(u3Job.data, slowCapture),
    "SENT",
  );
  eq("three emails", sent.length, 3);

  // One real send through sendMail and the mail catcher.
  const u1Job = jobOf(U1.userId);
  eq(
    "a real send through sendMail",
    await deliverPortalNotification(u1Job.data),
    "SENT",
  );
  const u1User = await db.portalUser.findUniqueOrThrow({
    where: { id: U1.userId },
  });
  const logs = await db.emailLog.findMany({
    where: { toAddress: u1User.email, kind: "portal.documents-shared" },
  });
  check(
    "one EmailLog row, SENT, on A in company 1",
    logs.length === 1 &&
      logs[0]?.status === "SENT" &&
      logs[0].companyId === c1.id &&
      logs[0].stakeholderId === A.id &&
      logs[0].relatedType === "portalNotification" &&
      logs[0].relatedId === u1Job.data.notificationId,
    JSON.stringify(logs.map((l) => [l.status, l.companyId, l.stakeholderId])),
  );
  const u1Row = await db.portalNotification.findUniqueOrThrow({
    where: { id: u1Job.data.notificationId },
  });
  check(
    "the row records the send and the EmailLog id",
    u1Row.claimedAt !== null &&
      u1Row.sentAt !== null &&
      u1Row.emailLogId === logs[0]?.id,
  );
  const caught = await mailCatcherBody(u1User.email);
  check("the mail catcher received it", caught !== null);
  const next = `/portal/${accessOf(U1, A)}/documents`;
  check(
    "its link is sign-in with next to A's documents page",
    (caught ?? "").includes(
      `${BASE}/portal/sign-in?next=${encodeURIComponent(next)}`,
    ),
  );
  eq(
    "and it names A only, 19 documents, no F, no other holder, no file",
    [
      (caught ?? "").includes(A.name),
      (caught ?? "").includes("19 new documents"),
      ...[F.name, B.name, C.name, E.name, ...names, ...twenty].map((f) =>
        (caught ?? "").includes(f),
      ),
    ].join(","),
    [
      "true",
      "true",
      ...Array(4 + names.length + twenty.length).fill("false"),
    ].join(","),
  );

  // A share where every pair already exists: nothing queued.
  const repeat = await team1.shareDocuments({
    documentPublicIds: twenty,
    stakeholderIds: [A.id, B.id, C.id],
    notify: true,
  });
  check(
    "re-sharing what everyone already has queues nothing",
    repeat.added === 0 &&
      repeat.notificationsQueued === 0 &&
      notifyJobs.length === 4,
  );
  // A new action: a new batch, one row per person again.
  const one = await document(c1, "notify21", await bucket(c1, "notify21"));
  const next21 = await team1.shareDocuments({
    documentPublicIds: [one.publicId],
    stakeholderIds: [A.id],
    notify: true,
  });
  const batches = await db.portalNotification.findMany({
    where: { companyId: c1.id },
    select: { batchKey: true, portalUserId: true },
  });
  check(
    "a new share action is a new batch (U1 and UM, once each)",
    next21.notificationsQueued === 2 &&
      new Set(batches.map((b) => b.batchKey)).size === 2 &&
      batches.filter((b) => b.portalUserId === UM.userId).length === 2,
    JSON.stringify(batches),
  );
  await deleteCaughtMail();
}

/** The HTML of the newest message to `address` in the local mail catcher (Mailpit), or null. */
async function mailCatcherBody(address: string): Promise<string | null> {
  try {
    const search = await fetch(
      `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=1`,
    );
    const found = (await search.json()) as { messages?: { ID: string }[] };
    const id = found.messages?.[0]?.ID;
    if (!id) return null;
    const message = await fetch(`http://localhost:8025/api/v1/message/${id}`);
    const body = (await message.json()) as { HTML?: string };
    return body.HTML ?? null;
  } catch {
    return null;
  }
}

/** Removes this script's messages from the mail catcher (best effort). */
async function deleteCaughtMail(): Promise<void> {
  try {
    const search = await fetch(
      `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${EMAIL_PREFIX}`)}&limit=200`,
    );
    const found = (await search.json()) as {
      messages?: { ID: string; To?: { Address: string }[] }[];
    };
    const ids = (found.messages ?? [])
      .filter((m) => m.To?.some((t) => t.Address.startsWith(EMAIL_PREFIX)))
      .map((m) => m.ID);
    if (ids.length === 0) return;
    await fetch("http://localhost:8025/api/v1/messages", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ IDs: ids }),
    });
  } catch {
    // The catcher is not needed to clean the database.
  }
}

async function noStorageKeys() {
  section("11. no storage key, bucket name or bucket id in any response");
  const buckets = await db.bucket.findMany({
    where: { id: { in: bucketIds } },
    select: { id: true, key: true },
  });
  const needles = [
    ...buckets.flatMap((b) => [b.id, b.key]),
    ...(PRIVATE_BUCKET ? [PRIVATE_BUCKET] : []),
  ];
  check(
    "responses were recorded",
    responses.length >= 10,
    `${responses.length}`,
  );
  const leaks = responses.flatMap((r) =>
    needles.filter((n) => r.json.includes(n)).map((n) => `${r.label}: ${n}`),
  );
  eq("no response contains one", JSON.stringify(leaks), "[]");
}

async function cleanupPortal() {
  section("cleanup");
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
  // Documents and templates are company rows (harness cleanup); buckets are not.
  await db.document.deleteMany({ where: { bucketId: { in: bucketIds } } });
  await db.template.deleteMany({ where: { bucketId: { in: bucketIds } } });
  await db.bucket.deleteMany({ where: { id: { in: bucketIds } } });
  for (const key of objectKeys) await deleteObject(key);
  const left =
    (await db.portalUser.count({ where: { id: { in: portalUserIds } } })) +
    (await db.portalAccessLog.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.bucket.count({ where: { id: { in: bucketIds } } }));
  eq("portal users, null-company log rows and buckets removed", left, 0);
}

await runScenarios([
  ["setup", setup],
  ["rbac and sessions", rbacAndSessions],
  ["no shares", noShares],
  ["share and see", shareAndSee],
  ["presets", presetsFrozen],
  ["holder-bound", holderBound],
  ["holder deleted", holderDeleted],
  ["cross-company", crossCompany],
  ["concurrent share", concurrentShare],
  ["open a real file", openRealFile],
  ["disabled access", disabledAccess],
  ["access log", accessLog],
  ["notifications", notifications],
  ["no storage keys", noStorageKeys],
  ["portal cleanup", cleanupPortal],
]);
