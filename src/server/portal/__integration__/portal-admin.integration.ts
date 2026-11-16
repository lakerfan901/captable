/**
 * Portal access admin (04-investor-portal.md 5.2 "Invitation", 5.6, rules
 * P1–P3, P9, P29–P31; package P3) against the local database. Not part of
 * `vitest run`. Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-admin.integration.ts
 *
 * Companies are named `zz-portal-admin-…`, portal users
 * `zz-portal-admin.…@example.com`. No email is sent: account-email jobs are
 * captured, and the script stands in for the worker by calling
 * `mintTokenForDelivery`. Every row created is deleted at the end.
 *
 * Covers: invite (new person, second holder, second company), duplicate and
 * concurrent invites (one row, one email), company isolation of every
 * procedure (reads and writes, including a person with access in both
 * companies), disable / enable against a live portal session, pending
 * invitation links after a disable, unlock, resend, re-invite of a disabled
 * access, `inviteHolder` for P4b (`LEFT_DISABLED`), RBAC refusals, the
 * production mail guard (nothing written), audit rows naming the address,
 * and no token or password in any stored row, job payload or output.
 *
 * `portalAdmin.holderView` (P9b, sections H1–H6, in two companies of their
 * own): for holders with reports, K-1 files and shared documents, the team
 * answer equals `portal.reports.list` / `portal.documents.list` (and the
 * published-through date of `portal.financials.get`) field for field,
 * again after unpublish, republish and unshare; K-1 privacy; a disabled
 * access; cross-company and unknown holders refused alike; RBAC.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Session } from "next-auth";
import { generatePublicId } from "@/common/id";
import { reportFileJob } from "@/jobs/governance-report-file";
import { todayInZone } from "@/lib/governance/dates";
import { syncComplianceDeadlines } from "@/server/governance/compliance";
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
import {
  mintTokenForDelivery,
  peekToken,
  setPasswordWithToken,
  verifySignIn,
} from "@/server/portal/account";
import {
  type PortalAccountEmailData,
  portalAccountEmailJob,
} from "@/server/portal/account-email";
import { inviteHolder } from "@/server/portal/invite";
import {
  createPortalSession,
  loadPortalSession,
  portalCookieName,
} from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { portalAdminRouter } from "@/trpc/routers/portal-admin-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";

setCompanyPrefix("zz-portal-admin-");
const EMAIL_PREFIX = "zz-portal-admin.";
const BASE = "http://localhost:3000";
const FACTS = { ip: "203.0.113.9", userAgent: "portal-admin-integration" };
const GOOD = "Copper-Kettle-Morning-71";
const WRONG = "Not-The-Password-At-All-3";
const PASSWORDS = [GOOD, WRONG];
const SECRETS: string[] = [];

// ---------------------------------------------------------------------------
// Captured account-email jobs

const emitted: PortalAccountEmailData[] = [];
const allEmitted: { data: unknown; options: unknown }[] = [];
Object.assign(portalAccountEmailJob, {
  emit: (data: PortalAccountEmailData, options?: unknown) => {
    emitted.push(data);
    allEmitted.push({ data, options });
    return Promise.resolve(null);
  },
});
const takeEmits = () => emitted.splice(0, emitted.length);

const output: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    output.push(typeof chunk === "string" ? chunk : String(chunk));
    // biome-ignore lint/suspicious/noExplicitAny: pass-through of the original arguments
    return (write as any)(chunk, ...rest);
  }) as typeof stream.write;
}

// ---------------------------------------------------------------------------
// Fixtures

const addr = (label: string) =>
  `${EMAIL_PREFIX}${label}.${randomUUID().slice(0, 8)}@example.com`;

const teamUserIds: string[] = [];

/** A team member with a custom role holding exactly `permissions`. */
async function createCustomMember(
  c: TestCompany,
  permissions: { subject: string; actions: string[] }[],
) {
  const user = await db.user.create({
    data: { name: "Custom", email: addr("team") },
  });
  teamUserIds.push(user.id);
  const role = await db.customRole.create({
    data: { companyId: c.id, name: "Custom", permissions },
  });
  const member = await db.member.create({
    data: {
      companyId: c.id,
      userId: user.id,
      status: "ACTIVE",
      isOnboarded: true,
      role: "CUSTOM",
      customRoleId: role.id,
    },
  });
  const session = {
    user: {
      id: user.id,
      name: "Custom",
      email: user.email,
      companyId: c.id,
      memberId: member.id,
      companyPublicId: c.name,
      isOnboarded: true,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;
  return {
    db,
    session,
    requestIp: "127.0.0.1",
    userAgent: "portal-admin-integration",
    headers: new Headers(),
  };
}

type Ctx = Awaited<ReturnType<typeof createAdmin>>["context"];
const admin = (ctx: Ctx) => createCallerFactory(portalAdminRouter)(ctx);

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
    // biome-ignore lint/suspicious/noExplicitAny: a forged context for the caller
  } as any);
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  const error = await errorOf(fn);
  return error === null ? "OK" : error.code;
}

const auditCount = (companyId: string, action: string) =>
  db.audit.count({ where: { companyId, action } });

async function userId(email: string) {
  const u = await db.portalUser.findUnique({ where: { email } });
  if (u === null) throw new Error(`no portal user ${email}`);
  return u.id;
}

/** Mints the secret of the newest usable SET_PASSWORD token, as the worker would. */
async function mintLatest(email: string) {
  const token = await db.portalAccountToken.findFirst({
    where: { portalUserId: await userId(email), usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (token === null) throw new Error("no usable token");
  const minted = await mintTokenForDelivery(db, token.id);
  if (minted === null) throw new Error("mint failed");
  SECRETS.push(minted.token);
  return { tokenId: token.id, ...minted };
}

let companyA: TestCompany;
let companyB: TestCompany;
let holderA1: { id: string; name: string };
let holderA2: { id: string; name: string };
let holderF: { id: string; name: string };
let adminA: Ctx;
let adminA2: Ctx;
let adminB: Ctx;
let readOnlyA: Ctx;
let noPortalA: Ctx;

const EMAIL_X = addr("x"); // the "two trusts" person: A1, A2 and F
const EMAIL_Y = addr("y"); // invited for A1 only, never sets up
let sessionX = "";
let accessA1 = "";
let accessA2 = "";
let accessF = "";
let accessY = "";

async function setup() {
  section("setup");
  companyA = await createCompany("one");
  companyB = await createCompany("two");
  holderA1 = await newMember(companyA, "Holder A1");
  holderA2 = await newMember(companyA, "Holder A2");
  holderF = await newMember(companyB, "Holder F");
  adminA = (await createAdmin(companyA)).context;
  adminA2 = (await createAdmin(companyA)).context;
  adminB = (await createAdmin(companyB)).context;
  readOnlyA = await createCustomMember(companyA, [
    { subject: "portal", actions: ["read"] },
    { subject: "stakeholder", actions: ["read"] },
  ]);
  noPortalA = await createCustomMember(companyA, [
    { subject: "stakeholder", actions: ["read", "update"] },
  ]);
  check("fixtures created", true);
}

// ---------------------------------------------------------------------------

async function invite() {
  section("1. invite a new person");
  const res = await admin(adminA).invite({
    stakeholderId: holderA1.id,
    email: `  ${EMAIL_X.toUpperCase()} `,
  });
  eq("outcome CREATED", res.outcome, "CREATED");
  eq("the address is normalised", res.email, EMAIL_X);
  check("something was sent", res.sent);
  check(
    "the answer carries no emailKind or token",
    !("emailKind" in res) && !("tokenId" in res),
  );
  accessA1 = res.accessId;
  eq(
    "one portal user",
    await db.portalUser.count({ where: { email: EMAIL_X } }),
    1,
  );
  const row = await db.portalAccess.findUniqueOrThrow({
    where: { publicId: accessA1 },
  });
  eq("access is ACTIVE", row.status, "ACTIVE");
  eq("access is in company A", row.companyId, companyA.id);
  eq("access is for A1", row.stakeholderId, holderA1.id);
  check("inviteSentAt set", row.inviteSentAt !== null);
  const emits = takeEmits();
  eq("one email queued", emits.length, 1);
  check(
    "it is INVITE with token and access",
    emits[0]?.kind === "INVITE" &&
      typeof emits[0]?.tokenId === "string" &&
      emits[0]?.accessId === row.id,
  );
  const audit = await db.audit.findFirst({
    where: { companyId: companyA.id, action: "portal.access-invited" },
  });
  check(
    "audit row names address and holder",
    audit?.summary?.includes(EMAIL_X) === true &&
      audit.summary.includes(holderA1.name),
  );
  const list = await admin(adminA).accessForHolder({
    stakeholderId: holderA1.id,
  });
  eq("accessForHolder lists it", list.length, 1);
  eq("status INVITED", list[0]?.status, "INVITED");
  check(
    "no password, hash or token field in the output",
    !/password(Hash)?"|token|hash/i.test(
      JSON.stringify(list).replace(/"passwordSet"/g, ""),
    ),
  );

  section("2. duplicate invites");
  const again = await admin(adminA).invite({
    stakeholderId: holderA1.id,
    email: EMAIL_X,
  });
  eq("same address again: ALREADY_ACTIVE", again.outcome, "ALREADY_ACTIVE");
  check("nothing sent", !again.sent);
  eq("no email queued", takeEmits().length, 0);
  eq(
    "still one access",
    await db.portalAccess.count({ where: { stakeholderId: holderA1.id } }),
    1,
  );
  eq(
    "still one audit row",
    await auditCount(companyA.id, "portal.access-invited"),
    1,
  );

  // Four concurrent invites of a brand-new address, from two team members
  // (double click + a colleague): one user, one access, one email.
  const results = await Promise.allSettled([
    admin(adminA).invite({ stakeholderId: holderA1.id, email: EMAIL_Y }),
    admin(adminA).invite({ stakeholderId: holderA1.id, email: EMAIL_Y }),
    admin(adminA2).invite({ stakeholderId: holderA1.id, email: EMAIL_Y }),
    admin(adminA2).invite({ stakeholderId: holderA1.id, email: EMAIL_Y }),
  ]);
  check(
    "all four concurrent invites answered without error",
    results.every((r) => r.status === "fulfilled"),
    JSON.stringify(
      results.filter((r) => r.status === "rejected").map((r) => String(r)),
    ),
  );
  const outcomes = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value.outcome)
    .sort()
    .join(",");
  eq(
    "one CREATED, three ALREADY_ACTIVE",
    outcomes,
    "ALREADY_ACTIVE,ALREADY_ACTIVE,ALREADY_ACTIVE,CREATED",
  );
  eq(
    "one portal user",
    await db.portalUser.count({ where: { email: EMAIL_Y } }),
    1,
  );
  eq(
    "one access",
    await db.portalAccess.count({
      where: { portalUserId: await userId(EMAIL_Y) },
    }),
    1,
  );
  eq("one email", takeEmits().length, 1);
  eq(
    "one token row",
    await db.portalAccountToken.count({
      where: { portalUserId: await userId(EMAIL_Y) },
    }),
    1,
  );
  eq(
    "one more audit row",
    await auditCount(companyA.id, "portal.access-invited"),
    2,
  );
  accessY = (
    await db.portalAccess.findFirstOrThrow({
      where: { portalUserId: await userId(EMAIL_Y) },
    })
  ).publicId;

  section("3. bad input");
  eq(
    "an invalid address is BAD_REQUEST",
    await codeOf(() =>
      admin(adminA).invite({
        stakeholderId: holderA1.id,
        email: "not-an-email",
      }),
    ),
    "BAD_REQUEST",
  );
  eq(
    "a holder of another company is NOT_FOUND",
    await codeOf(() =>
      admin(adminA).invite({ stakeholderId: holderF.id, email: addr("z") }),
    ),
    "NOT_FOUND",
  );
  eq(
    "an unknown holder is NOT_FOUND",
    await codeOf(() =>
      admin(adminA).invite({ stakeholderId: "nope-nope", email: addr("z") }),
    ),
    "NOT_FOUND",
  );
  eq("nothing queued by refusals", takeEmits().length, 0);
  eq(
    "no portal user created by refusals",
    await db.portalUser.count({
      where: { email: { startsWith: `${EMAIL_PREFIX}z.` } },
    }),
    0,
  );
}

async function setUpAndSecondHolder() {
  section("4. set password, then a second holder and a second company");
  const minted = await mintLatest(EMAIL_X);
  const set = await setPasswordWithToken(db, {
    token: minted.token,
    password: GOOD,
    ...FACTS,
  });
  check("password set through the invitation link", set.ok);
  if (!set.ok) return;
  sessionX = set.sessionToken;
  SECRETS.push(sessionX);
  takeEmits();
  const list = await admin(adminA).accessForHolder({
    stakeholderId: holderA1.id,
  });
  eq(
    "A1 access now ACTIVE",
    list.find((r) => r.accessId === accessA1)?.status,
    "ACTIVE",
  );

  const tokensBefore = await db.portalAccountToken.count({
    where: { portalUserId: await userId(EMAIL_X) },
  });
  const second = await admin(adminA).invite({
    stakeholderId: holderA2.id,
    email: EMAIL_X,
  });
  eq("A2 access CREATED", second.outcome, "CREATED");
  accessA2 = second.accessId;
  const emits = takeEmits();
  check(
    "the 'access added' email, no token",
    emits.length === 1 &&
      emits[0]?.kind === "ACCESS_ADDED" &&
      emits[0]?.tokenId === undefined,
  );
  eq(
    "no new token row",
    await db.portalAccountToken.count({
      where: { portalUserId: await userId(EMAIL_X) },
    }),
    tokensBefore,
  );

  const viaB = await admin(adminB).invite({
    stakeholderId: holderF.id,
    email: EMAIL_X,
  });
  eq("company B's invite CREATED", viaB.outcome, "CREATED");
  accessF = viaB.accessId;
  eq("company B: ACCESS_ADDED email", takeEmits()[0]?.kind, "ACCESS_ADDED");
  eq(
    "one portal user for the three accesses",
    await db.portalUser.count({ where: { email: EMAIL_X } }),
    1,
  );

  const me = await portalCaller(sessionX).me();
  eq("portal.me lists three holders", me.holders.length, 3);
  check(
    "portal.me lists A1, A2 and F",
    [accessA1, accessA2, accessF].every((a) =>
      me.holders.some((h) => h.access === a),
    ),
  );
}

async function isolation() {
  section("5. company isolation");
  const bList = await admin(adminB).accessForHolder({
    stakeholderId: holderF.id,
  });
  eq("company B sees one row for F", bList.length, 1);
  eq(
    "company B sees 'Invited', not that the person set a password elsewhere",
    bList[0]?.status,
    "INVITED",
  );
  check("company B: passwordSet false", bList[0]?.passwordSet === false);
  const bOverview = await admin(adminB).overview();
  const bJson = JSON.stringify([bList, bOverview]);
  eq("company B overview: only its own access", bOverview.length, 1);
  check(
    "company B's answers name no company-A holder or access",
    ![
      holderA1.id,
      holderA2.id,
      holderA1.name,
      accessA1,
      accessA2,
      accessY,
    ].some((s) => bJson.includes(s)),
  );
  const aOverview = await admin(adminA).overview();
  eq("company A overview: its three accesses", aOverview.length, 3);
  check(
    "company A's overview does not name F or its access",
    !JSON.stringify(aOverview).includes(accessF) &&
      !JSON.stringify(aOverview).includes(holderF.id),
  );
  eq(
    "B reading A's holder is NOT_FOUND",
    await codeOf(() =>
      admin(adminB).accessForHolder({ stakeholderId: holderA1.id }),
    ),
    "NOT_FOUND",
  );
  for (const [label, run] of [
    [
      "disable",
      () =>
        admin(adminB).setAccessStatus({
          accessId: accessA1,
          status: "DISABLED",
        }),
    ],
    ["resend", () => admin(adminB).resendInvite({ accessId: accessY })],
    ["unlock", () => admin(adminB).unlock({ accessId: accessA1 })],
    [
      "invite into A's holder",
      () =>
        admin(adminB).invite({ stakeholderId: holderA1.id, email: EMAIL_X }),
    ],
  ] as const) {
    eq(`B ${label} on company A is NOT_FOUND`, await codeOf(run), "NOT_FOUND");
  }
  const a1 = await db.portalAccess.findUniqueOrThrow({
    where: { publicId: accessA1 },
  });
  eq("A1 untouched by company B", a1.status, "ACTIVE");
  eq("nothing queued by company B's attempts", takeEmits().length, 0);
  eq(
    "no audit row for company A written by B",
    await db.audit.count({
      where: {
        companyId: companyA.id,
        actor: { path: ["id"], equals: adminB.session.user.id },
      },
    }),
    0,
  );
}

async function disableEnable() {
  section("6. disable / enable with a live session");
  const caller = portalCaller(sessionX);
  eq(
    "before: A1 passes the investor base",
    await codeOf(() => caller.home({ access: accessA1 })),
    "OK",
  );
  const r = await admin(adminA).setAccessStatus({
    accessId: accessA1,
    status: "DISABLED",
  });
  check("disabled", r.changed);
  eq(
    "next request: A1 is NOT_FOUND",
    await codeOf(() => caller.home({ access: accessA1 })),
    "NOT_FOUND",
  );
  eq(
    "A2 (same company) still works",
    await codeOf(() => caller.home({ access: accessA2 })),
    "OK",
  );
  eq(
    "F (other company) still works",
    await codeOf(() => caller.home({ access: accessF })),
    "OK",
  );
  const me = await caller.me();
  check(
    "portal.me no longer lists A1",
    me.holders.length === 2 && !me.holders.some((h) => h.access === accessA1),
  );
  check(
    "the session itself is kept (it still reaches A2 and F)",
    (await loadPortalSession(db, `${portalCookieName()}=${sessionX}`)) !== null,
  );
  const row = await db.portalAccess.findUniqueOrThrow({
    where: { publicId: accessA1 },
  });
  check(
    "disabledAt and disabledById set",
    row.disabledAt !== null && row.disabledById !== null,
  );
  eq(
    "one disabled audit row",
    await auditCount(companyA.id, "portal.access-disabled"),
    1,
  );

  const twice = await Promise.all([
    admin(adminA).setAccessStatus({ accessId: accessA1, status: "DISABLED" }),
    admin(adminA2).setAccessStatus({ accessId: accessA1, status: "DISABLED" }),
  ]);
  check(
    "disabling again changes nothing",
    twice.every((t) => !t.changed),
  );
  eq(
    "still one disabled audit row",
    await auditCount(companyA.id, "portal.access-disabled"),
    1,
  );

  const listed = await admin(adminA).accessForHolder({
    stakeholderId: holderA1.id,
  });
  eq(
    "card shows Disabled",
    listed.find((x) => x.accessId === accessA1)?.status,
    "DISABLED",
  );
  eq(
    "resend on a disabled access is NOT_FOUND",
    await codeOf(() => admin(adminA).resendInvite({ accessId: accessA1 })),
    "NOT_FOUND",
  );

  // Concurrent enable from two team members: one change, one audit row.
  const en = await Promise.all([
    admin(adminA).setAccessStatus({ accessId: accessA1, status: "ACTIVE" }),
    admin(adminA2).setAccessStatus({ accessId: accessA1, status: "ACTIVE" }),
  ]);
  eq(
    "exactly one enable changed the row",
    en.filter((e) => e.changed).length,
    1,
  );
  eq(
    "one enabled audit row",
    await auditCount(companyA.id, "portal.access-enabled"),
    1,
  );
  eq(
    "after enable: A1 works again on the same session",
    await codeOf(() => caller.home({ access: accessA1 })),
    "OK",
  );
  eq("enable sends no email", takeEmits().length, 0);

  section("7. a pending invitation link stops working while disabled");
  const y = await mintLatest(EMAIL_Y);
  check("Y's link works", (await peekToken(db, y.token)) !== null);
  await admin(adminA).setAccessStatus({
    accessId: accessY,
    status: "DISABLED",
  });
  check(
    "disabled: Y's link no longer opens",
    (await peekToken(db, y.token)) === null,
  );
  const refused = await setPasswordWithToken(db, {
    token: y.token,
    password: GOOD,
    ...FACTS,
  });
  check("disabled: Y cannot set a password with it", !refused.ok);

  section("8. re-invite a disabled access");
  const re = await admin(adminA).invite({
    stakeholderId: holderA1.id,
    email: EMAIL_Y,
  });
  eq("REACTIVATED", re.outcome, "REACTIVATED");
  const emits = takeEmits();
  check("a new invitation link is queued", emits[0]?.kind === "INVITE");
  check(
    "the earlier link was retired",
    (await peekToken(db, y.token)) === null,
  );
  eq(
    "still one access row for Y",
    await db.portalAccess.count({
      where: { portalUserId: await userId(EMAIL_Y) },
    }),
    1,
  );

  section("9. inviteHolder for P4b leaves a disabled access disabled");
  await admin(adminA).setAccessStatus({
    accessId: accessY,
    status: "DISABLED",
  });
  const before = await db.audit.count({ where: { companyId: companyA.id } });
  const left = await db.$transaction((tx) =>
    inviteHolder(tx, {
      companyId: companyA.id,
      stakeholderId: holderA1.id,
      email: EMAIL_Y,
      invitedById: adminA.session.user.memberId,
      reactivateDisabled: false,
      audit: {
        actorUserId: adminA.session.user.id,
        actorName: "Integration",
        requestIp: "127.0.0.1",
        userAgent: "x",
      },
    }),
  );
  eq("LEFT_DISABLED", left.outcome, "LEFT_DISABLED");
  check("no email kind", left.emailKind === null);
  eq(
    "no audit row",
    await db.audit.count({ where: { companyId: companyA.id } }),
    before,
  );
  eq(
    "still DISABLED",
    (await db.portalAccess.findUniqueOrThrow({ where: { publicId: accessY } }))
      .status,
    "DISABLED",
  );
  await admin(adminA).setAccessStatus({ accessId: accessY, status: "ACTIVE" });
  takeEmits();
}

async function resendAndUnlock() {
  section("10. resend");
  const yId = await userId(EMAIL_Y);
  const old = await mintLatest(EMAIL_Y);
  await admin(adminA).resendInvite({ accessId: accessY });
  const e1 = takeEmits();
  check(
    "no password: a new INVITE link for this access",
    e1.length === 1 &&
      e1[0]?.kind === "INVITE" &&
      e1[0]?.tokenId !== old.tokenId,
  );
  check(
    "the previous link stopped working",
    (await peekToken(db, old.token)) === null,
  );
  eq(
    "one usable token",
    await db.portalAccountToken.count({
      where: { portalUserId: yId, usedAt: null },
    }),
    1,
  );
  eq(
    "audit portal.invite-resent",
    await auditCount(companyA.id, "portal.invite-resent"),
    1,
  );
  const resentAudit = await db.audit.findFirst({
    where: { companyId: companyA.id, action: "portal.invite-resent" },
  });
  check(
    "resend audit names the address",
    resentAudit?.summary?.includes(EMAIL_Y) === true,
  );

  await admin(adminA).resendInvite({ accessId: accessA2 });
  eq(
    "password set: ACCESS_ADDED, no token",
    takeEmits()[0]?.kind,
    "ACCESS_ADDED",
  );

  section("11. unlock");
  for (let i = 0; i < 5; i++) {
    await verifySignIn(db, { email: EMAIL_X, password: WRONG, ...FACTS });
  }
  takeEmits();
  const locked = await admin(adminA).accessForHolder({
    stakeholderId: holderA2.id,
  });
  check("card shows Locked", locked[0]?.locked === true);
  const signInLocked = await verifySignIn(db, {
    email: EMAIL_X,
    password: GOOD,
    ...FACTS,
  });
  check("the right password is refused while locked", !signInLocked.ok);
  await admin(adminA).setAccessStatus({
    accessId: accessA1,
    status: "DISABLED",
  });
  eq(
    "unlock through a disabled access is NOT_FOUND",
    await codeOf(() => admin(adminA).unlock({ accessId: accessA1 })),
    "NOT_FOUND",
  );
  const un = await admin(adminA).unlock({ accessId: accessA2 });
  check("unlocked", un.unlocked);
  const u = await db.portalUser.findUniqueOrThrow({
    where: { email: EMAIL_X },
  });
  check(
    "lock and counter cleared",
    u.lockedUntil === null && u.failedSignIns === 0,
  );
  eq(
    "audit portal.account-unlocked",
    await auditCount(companyA.id, "portal.account-unlocked"),
    1,
  );
  const signIn = await verifySignIn(db, {
    email: EMAIL_X,
    password: GOOD,
    ...FACTS,
  });
  check("sign-in works after unlock", signIn.ok);
  if (signIn.ok) SECRETS.push(signIn.sessionToken);
  const again = await admin(adminA).unlock({ accessId: accessA2 });
  check("unlocking an unlocked account changes nothing", !again.unlocked);
  eq(
    "no second unlock audit",
    await auditCount(companyA.id, "portal.account-unlocked"),
    1,
  );
  // Two wrong passwords (no lock yet): unlock must not reset the counter.
  for (let i = 0; i < 2; i++) {
    await verifySignIn(db, { email: EMAIL_X, password: WRONG, ...FACTS });
  }
  const partial = await admin(adminA).unlock({ accessId: accessA2 });
  check("unlock without a lock in force writes nothing", !partial.unlocked);
  eq(
    "the failure counter is kept",
    (await db.portalUser.findUniqueOrThrow({ where: { email: EMAIL_X } }))
      .failedSignIns,
    2,
  );
  eq(
    "and no audit row",
    await auditCount(companyA.id, "portal.account-unlocked"),
    1,
  );
  await admin(adminA).setAccessStatus({ accessId: accessA1, status: "ACTIVE" });
  takeEmits();
}

async function rbac() {
  section("12. permissions");
  const ro = admin(readOnlyA);
  eq(
    "portal:read can list a holder's access",
    await codeOf(() => ro.accessForHolder({ stakeholderId: holderA1.id })),
    "OK",
  );
  eq(
    "portal:read can read the overview",
    await codeOf(() => ro.overview()),
    "OK",
  );
  eq(
    "portal:read cannot invite",
    await codeOf(() =>
      ro.invite({ stakeholderId: holderA1.id, email: addr("ro") }),
    ),
    "UNAUTHORIZED",
  );
  eq(
    "portal:read cannot disable",
    await codeOf(() =>
      ro.setAccessStatus({ accessId: accessA1, status: "DISABLED" }),
    ),
    "UNAUTHORIZED",
  );
  eq(
    "portal:read cannot resend",
    await codeOf(() => ro.resendInvite({ accessId: accessY })),
    "UNAUTHORIZED",
  );
  eq(
    "portal:read cannot unlock",
    await codeOf(() => ro.unlock({ accessId: accessA1 })),
    "UNAUTHORIZED",
  );
  const np = admin(noPortalA);
  eq(
    "without portal: accessForHolder refused",
    await codeOf(() => np.accessForHolder({ stakeholderId: holderA1.id })),
    "UNAUTHORIZED",
  );
  eq(
    "without portal: overview refused",
    await codeOf(() => np.overview()),
    "UNAUTHORIZED",
  );
  eq(
    "without portal: invite refused",
    await codeOf(() =>
      np.invite({ stakeholderId: holderA1.id, email: addr("np") }),
    ),
    "UNAUTHORIZED",
  );
  eq("nothing queued by refused callers", takeEmits().length, 0);
  eq(
    "A1 still ACTIVE",
    (await db.portalAccess.findUniqueOrThrow({ where: { publicId: accessA1 } }))
      .status,
    "ACTIVE",
  );
}

async function mailGuard() {
  section("13. production mail guard");
  const env = process.env as Record<string, string | undefined>;
  const saved = env.NODE_ENV;
  // This run's rows only (other scripts may run at the same time).
  const mine = { email: { startsWith: EMAIL_PREFIX } };
  const countRows = async () =>
    (await db.portalUser.count({ where: mine })) +
    (await db.portalAccess.count({
      where: { companyId: { in: [companyA.id, companyB.id] } },
    })) +
    (await db.portalAccountToken.count({ where: { portalUser: mine } })) +
    (await db.audit.count({ where: { companyId: companyA.id } }));
  const before = await countRows();
  const fresh = addr("guard");
  env.NODE_ENV = "production";
  try {
    const err = await errorOf(() =>
      admin(adminA).invite({ stakeholderId: holderA2.id, email: fresh }),
    );
    eq("invite refused", err?.code, "BAD_REQUEST");
    check(
      "with the mail message",
      err?.message.includes("Email is not configured for real delivery") ===
        true,
    );
    eq(
      "resend refused",
      await codeOf(() => admin(adminA).resendInvite({ accessId: accessY })),
      "BAD_REQUEST",
    );
    eq(
      "no user, access, token or audit row written",
      await countRows(),
      before,
    );
    eq("no email queued", takeEmits().length, 0);
    const d = await admin(adminA).setAccessStatus({
      accessId: accessA2,
      status: "DISABLED",
    });
    check("disable needs no email and still works", d.changed);
    await admin(adminA).setAccessStatus({
      accessId: accessA2,
      status: "ACTIVE",
    });
  } finally {
    env.NODE_ENV = saved;
  }
}

// ---------------------------------------------------------------------------
// holderView (package P9b): exactly what the portal lists for the holder
//
// Its own two companies, so the share / release audit rows and counts of
// these sections never touch companies A and B (section 14 reads those).
// Company V1: holders P and Q (Preferred), R (Common). Company V2: G.
// Portal user V has access to P and Q (two holders of one person) and to G;
// portal user W to R. Reports of V1: QR (quarterly, to P and Q), K (TAX_K1,
// K-1 files for P, Q and R, released to P and Q), N (notice to P only, a
// shared file and one private to P). Documents of V1: D1 shared with P and
// Q, D2 with P only, D3 (Q's own file) with Q.

const viewBucketIds: string[] = [];
const reportsCallerOf = (ctx: Ctx) =>
  createCallerFactory(memberReportRouter)(ctx);
// pg-boss is not started: the filing job a release queues is captured.
(reportFileJob as { emit: unknown }).emit = () => Promise.resolve();

interface ViewWorld {
  v1: TestCompany;
  v2: TestCompany;
  P: { id: string; name: string };
  Q: { id: string; name: string };
  R: { id: string; name: string };
  G: { id: string; name: string };
  admin1: Ctx;
  admin2: Ctx;
  reports1: ReturnType<typeof reportsCallerOf>;
  sessionV: string;
  sessionW: string;
  acc: Record<"P" | "Q" | "R" | "G", { id: string; publicId: string }>;
  QR: string;
  K: string;
  N: string;
  k1: Record<"P" | "Q" | "R", { id: string; name: string }>;
  docs: Record<"D1" | "D2" | "D3", string>;
}
let vw: ViewWorld;

function viewParagraph(text: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

async function viewBucket(c: TestCompany, label: string) {
  const row = await db.bucket.create({
    data: {
      name: `${label}.pdf`,
      key: `${c.id}/zz-portal-admin/${label}-${randomUUID().slice(0, 8)}.pdf`,
      mimeType: "application/pdf",
      size: 2048,
      tags: ["generic"],
    },
  });
  viewBucketIds.push(row.id);
  return row;
}

async function viewAttach(
  c: TestCompany,
  reportPublicId: string,
  label: string,
  stakeholderId: string | null,
  kind: "K1" | "GENERAL",
) {
  const report = await db.memberReport.findFirstOrThrow({
    where: { publicId: reportPublicId, companyId: c.id },
  });
  const bucket = await viewBucket(c, label);
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
  return { id: row.id, name: row.name };
}

async function viewDocument(
  c: TestCompany,
  label: string,
  stakeholderId: string | null = null,
) {
  const bucket = await viewBucket(c, label);
  const row = await db.document.create({
    data: {
      companyId: c.id,
      publicId: generatePublicId(),
      name: `${label}.pdf`,
      bucketId: bucket.id,
      stakeholderId,
      recordCategory: label === "D1" ? "CONSENTS_AND_MINUTES" : null,
    },
  });
  return row.publicId;
}

async function viewAccess(
  portalUserId: string,
  companyId: string,
  stakeholderId: string,
) {
  const row = await db.portalAccess.create({
    data: {
      publicId: `pa_${randomUUID().replace(/-/g, "")}`,
      portalUserId,
      companyId,
      stakeholderId,
      invitedById: "portal-admin-integration",
    },
  });
  return { id: row.id, publicId: row.publicId };
}

async function viewSession(portalUserId: string) {
  const { token } = await createPortalSession(db, {
    portalUserId,
    ip: FACTS.ip,
    userAgent: FACTS.userAgent,
    now: new Date(),
  });
  SECRETS.push(token);
  return token;
}

async function holderViewSetup() {
  section("H1. holderView fixture");
  const v1 = await createCompany("view-one");
  const v2 = await createCompany("view-two");
  const P = await newMember(v1, "P Preferred");
  const Q = await newMember(v1, "Q Preferred");
  const R = await newMember(v1, "R Common");
  const G = await newMember(v2, "G Preferred");
  await subscribe(v1, P.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-10",
  });
  await subscribe(v1, Q.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  await issueCommon(v1, R.id, "100", "2026-11-11");
  await subscribe(v2, G.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-10",
  });
  setToday(todayInZone(new Date(), v1.timezone));
  const a1 = await createAdmin(v1);
  const a2 = await createAdmin(v2);
  const reports1 = reportsCallerOf(a1.context);
  const reports2 = reportsCallerOf(a2.context);

  // QR: quarterly, to P and Q.
  const { publicId: QR } = await reports1.create({
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: 3,
  });
  const qrRow = await db.memberReport.findFirstOrThrow({
    where: { publicId: QR, companyId: v1.id },
  });
  const figures = JSON.parse(JSON.stringify(qrRow.figures)) as {
    utilization: { bps: number | null };
    managerPayments: { confirmedNone: boolean };
  };
  figures.utilization.bps = 8_500;
  figures.managerPayments.confirmedNone = true;
  await reports1.update({
    publicId: QR,
    title: "Q3 2026 report to Members",
    figures,
    commentary: [viewParagraph("A steady quarter.")],
  });
  await reports1.release({
    publicId: QR,
    stakeholderIds: [P.id, Q.id],
    email: false,
  });

  // K: TAX_K1 with K-1 files for P, Q and R; released to P and Q.
  await inTx((tx) => syncComplianceDeadlines(tx, v1.id, new Date()));
  const target = await db.complianceDeadline.findFirstOrThrow({
    where: { companyId: v1.id, dedupeKey: "K1_TARGET:2026" },
    select: { id: true },
  });
  const { publicId: K } = await reports1.create({
    type: "TAX_K1",
    fiscalYear: 2026,
    relatedType: "COMPLIANCE_DEADLINE",
    relatedId: target.id,
  });
  const k1 = {
    P: await viewAttach(v1, K, "K-1 for P", P.id, "K1"),
    Q: await viewAttach(v1, K, "K-1 for Q", Q.id, "K1"),
    R: await viewAttach(v1, K, "K-1 for R", R.id, "K1"),
  };
  await reports1.release({
    publicId: K,
    stakeholderIds: [P.id, Q.id],
    email: false,
  });

  // N: a notice to P only, with a shared file and a file private to P.
  const { publicId: N } = await reports1.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await reports1.update({
    publicId: N,
    title: "Notice for P",
    figures: {},
    commentary: [viewParagraph("For P.")],
  });
  await viewAttach(v1, N, "Shared letter", null, "GENERAL");
  await viewAttach(v1, N, "Letter for P", P.id, "GENERAL");
  await reports1.release({ publicId: N, stakeholderIds: [P.id], email: false });

  // Company V2: a notice to G.
  const { publicId: X } = await reports2.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  await reports2.update({
    publicId: X,
    title: "Company two notice",
    figures: {},
    commentary: [viewParagraph("For G.")],
  });
  await reports2.release({ publicId: X, stakeholderIds: [G.id], email: false });

  // Documents, shared through the team procedure.
  const docs = {
    D1: await viewDocument(v1, "D1"),
    D2: await viewDocument(v1, "D2"),
    D3: await viewDocument(v1, "D3", Q.id),
  };
  const team1 = admin(a1.context);
  await team1.shareDocuments({
    documentPublicIds: [docs.D1],
    stakeholderIds: [P.id, Q.id],
  });
  await team1.shareDocuments({
    documentPublicIds: [docs.D2],
    stakeholderIds: [P.id],
  });
  await team1.shareDocuments({
    documentPublicIds: [docs.D3],
    stakeholderIds: [Q.id],
  });
  const g2 = await viewDocument(v2, "G2");
  await admin(a2.context).shareDocuments({
    documentPublicIds: [g2],
    stakeholderIds: [G.id],
  });

  const V = await db.portalUser.create({ data: { email: addr("view-v") } });
  const W = await db.portalUser.create({ data: { email: addr("view-w") } });
  const acc = {
    P: await viewAccess(V.id, v1.id, P.id),
    Q: await viewAccess(V.id, v1.id, Q.id),
    G: await viewAccess(V.id, v2.id, G.id),
    R: await viewAccess(W.id, v1.id, R.id),
  };
  vw = {
    v1,
    v2,
    P,
    Q,
    R,
    G,
    admin1: a1.context,
    admin2: a2.context,
    reports1,
    sessionV: await viewSession(V.id),
    sessionW: await viewSession(W.id),
    acc,
    QR,
    K,
    N,
    k1,
    docs,
  };
  check("holderView fixture created", true);
}

type ViewHolder = "P" | "Q" | "R" | "G";

/** The portal's own lists for one holder, through its access. */
async function portalLists(h: ViewHolder) {
  const session = h === "R" ? vw.sessionW : vw.sessionV;
  const caller = portalCaller(session);
  const access = vw.acc[h].publicId;
  const [reports, documents, financials] = await Promise.all([
    caller.reports.list({ access }),
    caller.documents.list({ access }),
    caller.financials.get({ access }),
  ]);
  return { reports, documents, publishedThrough: financials.publishedThrough };
}

function teamView(h: ViewHolder) {
  const ctx = h === "G" ? vw.admin2 : vw.admin1;
  return admin(ctx).holderView({ stakeholderId: vw[h].id });
}

/** holderView equals the portal's lists for the holder, field for field. */
async function assertSame(label: string, h: ViewHolder) {
  const [mine, portal] = await Promise.all([teamView(h), portalLists(h)]);
  check(
    `${label}: ${h}'s reports equal portal.reports.list`,
    isDeepStrictEqual(mine.reports, portal.reports),
    JSON.stringify({ team: mine.reports, portal: portal.reports }),
  );
  check(
    `${label}: ${h}'s documents equal portal.documents.list`,
    isDeepStrictEqual(mine.documents, portal.documents),
    JSON.stringify({ team: mine.documents, portal: portal.documents }),
  );
  eq(
    `${label}: ${h}'s published-through date equals the portal's`,
    mine.publishedThrough,
    portal.publishedThrough,
  );
  return mine;
}

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

/** Deep equality of two values (`eq` compares with ===). */
function same(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    isDeepStrictEqual(actual, expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
}

async function holderViewEquality() {
  section("H2. holderView equals what the portal lists");
  for (const h of ["P", "Q", "R", "G"] as const) {
    await assertSame("initially", h);
  }
  const p = await teamView("P");
  const q = await teamView("Q");
  const r = await teamView("R");
  same("P sees QR, K and N", idsOf(p.reports), [vw.QR, vw.K, vw.N].sort());
  same("Q sees QR and K", idsOf(q.reports), [vw.QR, vw.K].sort());
  eq("R sees no report (not a recipient)", r.reports.length, 0);
  same("P sees D1 and D2", idsOf(p.documents), [vw.docs.D1, vw.docs.D2].sort());
  same(
    "Q sees D1 and its own D3",
    idsOf(q.documents),
    [vw.docs.D1, vw.docs.D3].sort(),
  );
  eq("R sees no document", r.documents.length, 0);
  eq("P's name is the holder's", p.holderName, vw.P.name);
  eq("P has one active access", p.activeAccesses, 1);
  check(
    "previewable is a boolean",
    typeof p.previewable === "boolean" && typeof r.previewable === "boolean",
  );
  eq("R has no published-through date", r.publishedThrough, null);
  check(
    "no storage key or bucket id in the answer",
    !/bucketId|"key"|zz-portal-admin\//.test(JSON.stringify([p, q, r])),
  );

  section("H3. K-1 privacy");
  const kP = p.reports.find((x) => x.id === vw.K);
  const kQ = q.reports.find((x) => x.id === vw.K);
  check("P's K report carries a file of P's own", kP?.hasOwnFiles === true);
  check("Q's K report carries a file of Q's own", kQ?.hasOwnFiles === true);
  const pJson = JSON.stringify(p);
  check(
    "P's view names no other holder's K-1 (name or id)",
    ![vw.k1.Q, vw.k1.R].some(
      (f) => pJson.includes(f.id) || pJson.includes(f.name),
    ),
  );
  check(
    "R holds a K-1 file on K but is not a recipient: K is not in R's view",
    !idsOf(r.reports).includes(vw.K),
  );
  // The report page's files of K for P and Q, through the portal, stay
  // each holder's own (the dialog relies on the same rule).
  const getK = (h: "P" | "Q") =>
    portalCaller(vw.sessionV).reports.get({
      access: vw.acc[h].publicId,
      reportId: vw.K,
    });
  const [gP, gQ] = await Promise.all([getK("P"), getK("Q")]);
  same(
    "the portal shows P only P's K-1",
    gP.attachments.map((a) => a.id),
    [vw.k1.P.id],
  );
  same(
    "the portal shows Q only Q's K-1",
    gQ.attachments.map((a) => a.id),
    [vw.k1.Q.id],
  );
}

async function holderViewChanges() {
  section("H4. after unpublish, republish and unshare");
  await vw.reports1.unpublish({ publicId: vw.N });
  const p1 = await assertSame("after unpublishing N", "P");
  check("N is gone from P's view", !idsOf(p1.reports).includes(vw.N));
  await assertSame("after unpublishing N", "Q");
  await vw.reports1.publish({ publicId: vw.N });
  const p2 = await assertSame("after publishing N again", "P");
  check("N is back in P's view", idsOf(p2.reports).includes(vw.N));

  await admin(vw.admin1).unshareDocument({
    documentPublicId: vw.docs.D1,
    stakeholderIds: [vw.P.id],
  });
  const p3 = await assertSame("after unsharing D1 from P", "P");
  check("D1 is gone from P's view", !idsOf(p3.documents).includes(vw.docs.D1));
  const q3 = await assertSame("after unsharing D1 from P", "Q");
  check("D1 stays in Q's view", idsOf(q3.documents).includes(vw.docs.D1));

  section("H5. a disabled access: the portal refuses, the team still sees");
  await db.portalAccess.update({
    where: { id: vw.acc.P.id },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  eq(
    "the portal list is NOT_FOUND for the disabled access",
    await codeOf(() =>
      portalCaller(vw.sessionV).reports.list({ access: vw.acc.P.publicId }),
    ),
    "NOT_FOUND",
  );
  const p4 = await teamView("P");
  eq("holderView: no active access", p4.activeAccesses, 0);
  same(
    "holderView still lists what an access would show",
    idsOf(p4.reports),
    idsOf(p3.reports),
  );
  await db.portalAccess.update({
    where: { id: vw.acc.P.id },
    data: { status: "ACTIVE", disabledAt: null },
  });
  await assertSame("after enabling again", "P");
}

async function holderViewRefusals() {
  section("H6. holderView refusals");
  const t1 = admin(vw.admin1);
  eq(
    "a holder of another company is NOT_FOUND",
    await codeOf(() => t1.holderView({ stakeholderId: vw.G.id })),
    "NOT_FOUND",
  );
  eq(
    "and the other way round",
    await codeOf(() => admin(vw.admin2).holderView({ stakeholderId: vw.P.id })),
    "NOT_FOUND",
  );
  eq(
    "an unknown holder is NOT_FOUND",
    await codeOf(() => t1.holderView({ stakeholderId: "nope-nope" })),
    "NOT_FOUND",
  );
  const unknown = await errorOf(() =>
    t1.holderView({ stakeholderId: "nope-nope" }),
  );
  const foreign = await errorOf(() =>
    t1.holderView({ stakeholderId: vw.G.id }),
  );
  eq("both refusals read the same", foreign?.message, unknown?.message);
  eq(
    "portal: read may see what a member sees",
    await codeOf(() =>
      admin(readOnlyA).holderView({ stakeholderId: holderA1.id }),
    ),
    "OK",
  );
  eq(
    "without portal: holderView refused",
    await codeOf(() =>
      admin(noPortalA).holderView({ stakeholderId: holderA1.id }),
    ),
    "UNAUTHORIZED",
  );
}

async function holderViewCleanup() {
  await db.document.deleteMany({ where: { bucketId: { in: viewBucketIds } } });
  await db.memberReportAttachment.deleteMany({
    where: { bucketId: { in: viewBucketIds } },
  });
  await db.bucket.deleteMany({ where: { id: { in: viewBucketIds } } });
  eq(
    "holderView buckets removed",
    await db.bucket.count({ where: { id: { in: viewBucketIds } } }),
    0,
  );
}

async function noSecrets() {
  section("14. no token or password stored, queued or printed");
  const ids = (
    await db.portalUser.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    })
  ).map((u) => u.id);
  const rows = [
    ...(await db.portalUser.findMany({ where: { id: { in: ids } } })),
    ...(await db.portalAccess.findMany({
      where: { portalUserId: { in: ids } },
    })),
    ...(await db.portalAccountToken.findMany({
      where: { portalUserId: { in: ids } },
    })),
    ...(await db.portalSession.findMany({
      where: { portalUserId: { in: ids } },
    })),
    ...(await db.portalAccessLog.findMany({
      where: { portalUserId: { in: ids } },
    })),
    ...(await db.audit.findMany({
      where: { companyId: { in: [companyA.id, companyB.id] } },
    })),
  ];
  const json = JSON.stringify(rows);
  check(`${rows.length} rows scanned`, rows.length > 20);
  check(`${SECRETS.length} secrets collected`, SECRETS.length >= 4);
  check(
    "no raw token, session value or password in any row",
    ![...SECRETS, ...PASSWORDS].some((s) => json.includes(s)),
  );
  const payloads = JSON.stringify(allEmitted);
  check(
    "no job payload or singleton key carries a secret",
    ![...SECRETS, ...PASSWORDS].some((s) => payloads.includes(s)),
  );
  check(
    "job payloads carry row ids only",
    allEmitted.every(({ data }) =>
      Object.keys(data as object).every((k) =>
        ["kind", "tokenId", "accessId", "eventId"].includes(k),
      ),
    ),
  );
  const audits = await db.audit.findMany({
    where: {
      companyId: { in: [companyA.id, companyB.id] },
      action: { startsWith: "portal." },
    },
  });
  check(
    "every portal audit row names an address",
    audits.length > 5 &&
      audits.every((a) => a.summary?.includes(EMAIL_PREFIX) === true),
  );
  check(
    "nothing secret printed",
    ![...SECRETS, ...PASSWORDS].some((s) => output.join("").includes(s)),
  );
}

async function cleanupPortal() {
  const ids = (
    await db.portalUser.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    })
  ).map((u) => u.id);
  await db.portalAccessLog.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalSession.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalAccountToken.deleteMany({
    where: { portalUserId: { in: ids } },
  });
  await db.portalAccess.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalUser.deleteMany({ where: { id: { in: ids } } });
  await db.member.deleteMany({ where: { userId: { in: teamUserIds } } });
  await db.customRole.deleteMany({
    where: {
      companyId: {
        in: [companyA?.id, companyB?.id].filter(Boolean) as string[],
      },
    },
  });
  await db.user.deleteMany({ where: { id: { in: teamUserIds } } });
  const left =
    (await db.portalUser.count({ where: { id: { in: ids } } })) +
    (await db.portalAccess.count({ where: { portalUserId: { in: ids } } })) +
    (await db.user.count({ where: { id: { in: teamUserIds } } }));
  eq("portal rows and custom team users removed", left, 0);
}

await runScenarios([
  ["setup", setup],
  ["invite", invite],
  ["set up and second holder", setUpAndSecondHolder],
  ["isolation", isolation],
  ["disable and enable", disableEnable],
  ["resend and unlock", resendAndUnlock],
  ["permissions", rbac],
  ["mail guard", mailGuard],
  ["holderView fixture", holderViewSetup],
  ["holderView equality", holderViewEquality],
  ["holderView changes", holderViewChanges],
  ["holderView refusals", holderViewRefusals],
  ["no secrets", noSecrets],
  ["portal cleanup", cleanupPortal],
  ["holderView cleanup", holderViewCleanup],
]);
