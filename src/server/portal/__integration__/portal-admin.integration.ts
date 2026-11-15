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
 */
import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
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
  type TestCompany,
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
import { loadPortalSession, portalCookieName } from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
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
    "NOT_IMPLEMENTED",
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
    "NOT_IMPLEMENTED",
  );
  eq(
    "F (other company) still works",
    await codeOf(() => caller.home({ access: accessF })),
    "NOT_IMPLEMENTED",
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
    "NOT_IMPLEMENTED",
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
  ["no secrets", noSecrets],
  ["portal cleanup", cleanupPortal],
]);
