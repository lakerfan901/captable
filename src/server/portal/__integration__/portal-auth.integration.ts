/**
 * Portal accounts, passwords and sessions (04-investor-portal.md 5.2, 5.3,
 * package P2a) against the local database. Not part of `vitest run`. Run
 * from the repository root:
 *
 *   set -a; . ./.env; set +a; SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/portal-auth.integration.ts
 *
 * Companies are named `zz-portal-auth-…`, portal users `zz-portal-auth.…@
 * example.com`. No email is sent: account-email jobs are captured (the
 * worker is package P2b), and the script stands in for the worker by calling
 * `mintTokenForDelivery`. Every row created is deleted at the end.
 *
 * Covers: invitation → set password → session; weak password keeps the
 * link; single use (also under two concurrent consumes); expired link; five
 * wrong passwords lock (also when the fifth and sixth race), the right one is
 * refused during the lock, the lock ends by itself; reset during a lock;
 * reset revokes every session and outstanding link; disabled access;
 * neutral answers; the per-address throttle; idle and absolute session ends;
 * change password; the procedure base (cookie only, Origin, team session,
 * other users' accesses); no token or password in any stored row.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PortalEventEnum } from "@/prisma/enums";
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
} from "@/server/llc/__integration__/harness";
import {
  changePassword,
  issueToken,
  mintTokenForDelivery,
  peekToken,
  requestPasswordReset,
  setPasswordWithToken,
  verifySignIn,
} from "@/server/portal/account";
import {
  type PortalAccountEmailData,
  portalAccountEmailJob,
} from "@/server/portal/account-email";
import {
  loadPortalSession,
  portalCookieName,
  revokeSession,
} from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { portalAuthRouter } from "@/trpc/routers/portal-auth-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";
import { securityRouter } from "@/trpc/routers/security-router/router";

setCompanyPrefix("zz-portal-auth-");
const EMAIL_PREFIX = "zz-portal-auth.";
const BASE = "http://localhost:3000";
const FACTS = { ip: "203.0.113.7", userAgent: "portal-auth-integration" };

const GOOD = "Correct-Horse-Battery-9";
const GOOD_2 = "Purple-Lantern-Orbit-42";
const GOOD_3 = "Quiet-Meadow-Copper-17";
const WRONG = "Wrong-Password-Entirely-1";
/** Every password used, to prove none is stored anywhere. */
const PASSWORDS = [GOOD, GOOD_2, GOOD_3, WRONG];
/** Every raw token and session value seen, likewise. */
const SECRETS: string[] = [];

// ---------------------------------------------------------------------------
// Captured account-email jobs (the worker is P2b)

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

// Everything written to stdout and stderr (console, Prisma's error log), to
// prove that no token or password is ever printed.
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

const portalUserIds: string[] = [];

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
      invitedById: "portal-auth-integration",
    },
  });
}

/** Issues a token and mints its secret, as invite + the email job would. */
async function emailedToken(
  portalUserId: string,
  purpose: "SET_PASSWORD" | "RESET_PASSWORD",
  opts: { nextPath?: string; now?: Date } = {},
) {
  const { tokenId } = await db.$transaction((tx) =>
    issueToken(tx, {
      portalUserId,
      purpose,
      nextPath: opts.nextPath,
      requestIp: FACTS.ip,
      now: opts.now,
    }),
  );
  const minted = await mintTokenForDelivery(db, tokenId, opts.now);
  if (minted === null) throw new Error("mint failed");
  SECRETS.push(minted.token);
  return { tokenId, ...minted };
}

function portalCaller(
  sessionToken: string | null,
  opts: {
    origin?: string | null;
    source?: string;
    teamSession?: unknown;
  } = {},
) {
  const headers = new Headers();
  if (sessionToken !== null) {
    headers.set("cookie", `${portalCookieName()}=${sessionToken}`);
  }
  const origin = opts.origin === undefined ? BASE : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.source) headers.set("x-trpc-source", opts.source);
  const ctx = {
    db,
    // biome-ignore lint/suspicious/noExplicitAny: a forged context for the caller
    session: (opts.teamSession ?? null) as any,
    requestIp: FACTS.ip,
    userAgent: FACTS.userAgent,
    headers,
  };
  return {
    portal: createCallerFactory(portalRouter)(ctx),
    portalAuth: createCallerFactory(portalAuthRouter)(ctx),
    memberReport: createCallerFactory(memberReportRouter)(ctx),
    security: createCallerFactory(securityRouter)(ctx),
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  const error = await errorOf(fn);
  return error === null ? "OK" : error.code;
}

function liveSessions(portalUserId: string) {
  return db.portalSession.count({ where: { portalUserId, revokedAt: null } });
}

function logCount(portalUserId: string, event: PortalEventEnum) {
  return db.portalAccessLog.count({
    where: { portalUserId, event },
  });
}

// Shared across scenarios
let companyA: Awaited<ReturnType<typeof createCompany>>;
let companyB: Awaited<ReturnType<typeof createCompany>>;
let holderA: { id: string };
let holderB: { id: string };
let holderF: { id: string };

async function setup() {
  section("setup");
  companyA = await createCompany("one");
  companyB = await createCompany("two");
  holderA = await newMember(companyA, "Holder A");
  holderB = await newMember(companyA, "Holder B");
  holderF = await newMember(companyB, "Holder F");
  check("fixtures created", true);
}

// ---------------------------------------------------------------------------
// 1. Invitation, set password, session, procedure base

async function invitationFlow() {
  section("1. invitation → set password → session → portal.me");
  const user = await newPortalUser("u1");
  const accessA = await grant(user.id, companyA.id, holderA.id);
  const accessF = await grant(user.id, companyB.id, holderF.id);
  const other = await newPortalUser("u2");
  const accessB = await grant(other.id, companyA.id, holderB.id);

  const invite = await emailedToken(user.id, "SET_PASSWORD", {
    nextPath: "/portal/go/report/abc",
  });
  check(
    "the link is under /portal/set-password/",
    invite.url === `${BASE}/portal/set-password/${invite.token}`,
  );
  const peek = await peekToken(db, invite.token);
  eq("peekToken names the invited address", peek?.email, user.email);

  const weak = await setPasswordWithToken(db, {
    token: invite.token,
    password: "password1234",
    ...FACTS,
  });
  check(
    "a weak password is refused with its reason",
    !weak.ok && weak.reason === "WEAK" && weak.problem === "COMMON",
  );
  check(
    "after a weak password the link still works",
    (await peekToken(db, invite.token)) !== null,
  );

  const set = await setPasswordWithToken(db, {
    token: invite.token,
    password: GOOD,
    ...FACTS,
  });
  check("a good password is accepted", set.ok);
  if (!set.ok) return;
  SECRETS.push(set.sessionToken);
  eq("next is the token's validated path", set.next, "/portal/go/report/abc");
  const stored = await db.portalUser.findUniqueOrThrow({
    where: { id: user.id },
  });
  check(
    "the stored hash is bcrypt ($2…) with cost 12",
    stored.passwordHash?.startsWith("$2") === true &&
      bcrypt.getRounds(stored.passwordHash ?? "") === 12,
  );
  check(
    "the stored hash verifies the exact password",
    await bcrypt.compare(GOOD, stored.passwordHash ?? ""),
  );
  check("passwordSetAt is set", stored.passwordSetAt !== null);
  eq("PASSWORD_SET logged", await logCount(user.id, "PASSWORD_SET"), 1);
  eq("SIGNED_IN logged", await logCount(user.id, "SIGNED_IN"), 1);
  const emails = takeEmits();
  eq("one email queued", emails.length, 1);
  eq("it is the password-changed email", emails[0]?.kind, "PASSWORD_CHANGED");

  const again = await setPasswordWithToken(db, {
    token: invite.token,
    password: GOOD_2,
    ...FACTS,
  });
  check(
    "the same link a second time is EXPIRED",
    !again.ok && again.reason === "EXPIRED",
  );
  check(
    "peekToken refuses the used link",
    (await peekToken(db, invite.token)) === null,
  );

  // Procedure base
  const caller = portalCaller(set.sessionToken);
  const me = await caller.portal.me();
  eq("portal.me returns the address", me.email, user.email);
  eq("portal.me lists both holders", me.holders.length, 2);
  check(
    "portal.me returns access public ids only",
    me.holders.every((h) =>
      [accessA.publicId, accessF.publicId].includes(h.access),
    ) && !JSON.stringify(me).includes(holderA.id),
  );
  check(
    "portal.me is sorted by company",
    me.holders[0]?.companyName === companyA.name,
  );
  eq(
    "investorProcedure with the user's own access passes the base",
    await codeOf(() => caller.portal.home({ access: accessA.publicId })),
    "NOT_IMPLEMENTED",
  );
  eq(
    "another user's access is NOT_FOUND",
    await codeOf(() => caller.portal.home({ access: accessB.publicId })),
    "NOT_FOUND",
  );
  eq(
    "an unknown access is NOT_FOUND",
    await codeOf(() => caller.portal.home({ access: "pa_doesnotexist" })),
    "NOT_FOUND",
  );
  eq(
    "no cookie is UNAUTHORIZED",
    await codeOf(() => portalCaller(null).portal.me()),
    "UNAUTHORIZED",
  );
  const admin = await createAdmin(companyA);
  eq(
    "a team session alone is UNAUTHORIZED on portal.me",
    await codeOf(() =>
      portalCaller(null, { teamSession: admin.session }).portal.me(),
    ),
    "UNAUTHORIZED",
  );
  eq(
    "a team session alone is UNAUTHORIZED on an investor procedure",
    await codeOf(() =>
      portalCaller(null, { teamSession: admin.session }).portal.home({
        access: accessA.publicId,
      }),
    ),
    "UNAUTHORIZED",
  );
  eq(
    "a portal session alone is UNAUTHORIZED on memberReport.list",
    await codeOf(() => caller.memberReport.list({})),
    "UNAUTHORIZED",
  );
  eq(
    "a portal session alone is UNAUTHORIZED on security.updatePassword",
    await codeOf(() =>
      caller.security.updatePassword({
        currentPassword: GOOD,
        newPassword: GOOD_2,
      }),
    ),
    "UNAUTHORIZED",
  );
  const forged = `${set.sessionToken.slice(0, 42)}${
    set.sessionToken.endsWith("A") ? "E" : "A"
  }`;
  eq(
    "a forged cookie value is UNAUTHORIZED",
    await codeOf(() => portalCaller(forged).portal.me()),
    "UNAUTHORIZED",
  );
  eq(
    "a mutation from a foreign Origin is FORBIDDEN",
    await codeOf(() =>
      portalCaller(set.sessionToken, {
        origin: "https://evil.example",
      }).portal.changePassword({ currentPassword: GOOD, newPassword: GOOD_2 }),
    ),
    "FORBIDDEN",
  );
  eq(
    "a mutation with Origin: null is FORBIDDEN",
    await codeOf(() =>
      portalCaller(set.sessionToken, {
        origin: "null",
      }).portal.changePassword({ currentPassword: GOOD, newPassword: GOOD_2 }),
    ),
    "FORBIDDEN",
  );
  eq(
    "a mutation without Origin is FORBIDDEN",
    await codeOf(() =>
      portalCaller(set.sessionToken, {
        origin: null,
      }).portal.changePassword({ currentPassword: GOOD, newPassword: GOOD_2 }),
    ),
    "FORBIDDEN",
  );
  eq(
    "a query needs no Origin",
    await codeOf(() =>
      portalCaller(set.sessionToken, { origin: null }).portal.me(),
    ),
    "OK",
  );
  check(
    "lastSeenAt of the access was recorded",
    (await db.portalAccess.findUniqueOrThrow({ where: { id: accessA.id } }))
      .lastSeenAt !== null,
  );

  // Disable takes effect on the next request (P9).
  await db.portalAccess.update({
    where: { id: accessA.id },
    data: { status: "DISABLED", disabledAt: new Date() },
  });
  eq(
    "after Disable the same session's next request for A is NOT_FOUND",
    await codeOf(() => caller.portal.home({ access: accessA.publicId })),
    "NOT_FOUND",
  );
  eq(
    "F still works",
    await codeOf(() => caller.portal.home({ access: accessF.publicId })),
    "NOT_IMPLEMENTED",
  );
  eq("portal.me lists only F", (await caller.portal.me()).holders.length, 1);
  // A holder deleted without its access row: no access.
  await db.portalAccess.update({
    where: { id: accessA.id },
    data: { status: "ACTIVE", disabledAt: null },
  });
  const ghost = await newMember(companyA, "Ghost");
  const ghostAccess = await grant(user.id, companyA.id, ghost.id);
  await db.stakeholder.delete({ where: { id: ghost.id } });
  eq(
    "an access whose holder was deleted is NOT_FOUND",
    await codeOf(() => caller.portal.home({ access: ghostAccess.publicId })),
    "NOT_FOUND",
  );
  eq(
    "and portal.me does not list it",
    (await caller.portal.me()).holders.length,
    2,
  );
  // An access copied to a non-LLC company is refused.
  await db.company.update({
    where: { id: companyB.id },
    data: { entityType: "CORPORATION" },
  });
  eq(
    "an access of a non-LLC company is NOT_FOUND",
    await codeOf(() => caller.portal.home({ access: accessF.publicId })),
    "NOT_FOUND",
  );
  await db.company.update({
    where: { id: companyB.id },
    data: { entityType: "LLC" },
  });
  takeEmits();
}

// ---------------------------------------------------------------------------
// 2. Lockout, lock notice, reset during a lock

async function withPassword(label: string, password = GOOD) {
  const user = await newPortalUser(label);
  await grant(user.id, companyA.id, holderA.id);
  const t = await emailedToken(user.id, "SET_PASSWORD");
  const set = await setPasswordWithToken(db, {
    token: t.token,
    password,
    ...FACTS,
  });
  if (!set.ok) throw new Error("set password failed");
  SECRETS.push(set.sessionToken);
  takeEmits();
  return { user, sessionToken: set.sessionToken };
}

async function lockout() {
  section("2. five wrong passwords lock; reset works during the lock");
  const { user, sessionToken: firstSession } = await withPassword("lock");
  const ok = await verifySignIn(db, {
    email: user.email.toUpperCase(),
    password: GOOD,
    ...FACTS,
  });
  check("sign-in with the right password (address case-insensitive)", ok.ok);
  if (ok.ok) SECRETS.push(ok.sessionToken);

  for (let i = 1; i <= 4; i++) {
    const r = await verifySignIn(db, {
      email: user.email,
      password: WRONG,
      ...FACTS,
    });
    check(`wrong password ${i} refused`, !r.ok);
  }
  let row = await db.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  check(
    "after four: counter 4, not locked",
    row.failedSignIns === 4 && row.lockedUntil === null,
  );
  const before = Date.now();
  const fifth = await verifySignIn(db, {
    email: user.email,
    password: WRONG,
    ...FACTS,
  });
  check("the fifth is refused", !fifth.ok);
  row = await db.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  const lockMs = (row.lockedUntil?.getTime() ?? 0) - before;
  check(
    "the fifth locks for 15 minutes and zeroes the counter",
    row.failedSignIns === 0 &&
      lockMs > 14 * 60_000 &&
      lockMs <= 15 * 60_000 + 5_000,
    `lock ${lockMs} ms`,
  );
  eq(
    "ACCOUNT_LOCKED logged once",
    await logCount(user.id, "ACCOUNT_LOCKED"),
    1,
  );
  const locks = takeEmits();
  check(
    "one lock email queued",
    locks.length === 1 && locks[0]?.kind === "LOCKED",
    JSON.stringify(locks),
  );

  const during = await verifySignIn(db, {
    email: user.email,
    password: GOOD,
    ...FACTS,
  });
  check(
    "the right password during the lock is refused, same shape",
    JSON.stringify(during) === JSON.stringify({ ok: false }),
  );
  const lockedRow = await db.portalUser.findUniqueOrThrow({
    where: { id: user.id },
  });
  check(
    "attempts during the lock neither count nor extend it",
    lockedRow.failedSignIns === 0 &&
      lockedRow.lockedUntil?.getTime() === row.lockedUntil?.getTime(),
  );
  const afterLock = new Date((row.lockedUntil?.getTime() ?? 0) + 1_000);
  const later = await verifySignIn(db, {
    email: user.email,
    password: GOOD,
    ...FACTS,
    now: afterLock,
  });
  check("one second after the lock ends the right password works", later.ok);
  if (later.ok) SECRETS.push(later.sessionToken);

  // Lock again; the second lock within 24 h sends no second notice.
  for (let i = 0; i < 5; i++) {
    await verifySignIn(db, {
      email: user.email,
      password: WRONG,
      ...FACTS,
      now: afterLock,
    });
  }
  row = await db.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  check("locked again", row.lockedUntil !== null);
  eq(
    "ACCOUNT_LOCKED logged twice",
    await logCount(user.id, "ACCOUNT_LOCKED"),
    2,
  );
  eq("no second lock email within 24 h", takeEmits().length, 0);

  // Reset during the lock.
  await requestPasswordReset(db, { email: user.email, requestIp: FACTS.ip });
  const resets = takeEmits();
  check(
    "a reset email is queued during the lock",
    resets.length === 1 && resets[0]?.kind === "RESET" && !!resets[0]?.tokenId,
  );
  const minted = await mintTokenForDelivery(db, resets[0]?.tokenId ?? "");
  check("the job can mint the reset link", minted !== null);
  if (minted === null) return;
  SECRETS.push(minted.token);
  eq("it is a RESET_PASSWORD link", minted.purpose, "RESET_PASSWORD");
  const outstanding = await emailedToken(user.id, "SET_PASSWORD");
  check("sessions exist before the reset", (await liveSessions(user.id)) >= 2);
  const reset = await setPasswordWithToken(db, {
    token: minted.token,
    password: GOOD_2,
    ...FACTS,
  });
  check("the reset sets the new password and signs in", reset.ok);
  if (!reset.ok) return;
  SECRETS.push(reset.sessionToken);
  row = await db.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  check(
    "the reset clears the lock",
    row.lockedUntil === null && row.failedSignIns === 0,
  );
  eq("only the new session is live", await liveSessions(user.id), 1);
  check(
    "the old session cookie is refused",
    (await loadPortalSession(db, `${portalCookieName()}=${firstSession}`)) ===
      null,
  );
  eq(
    "and the old cookie is UNAUTHORIZED on portal.me",
    await codeOf(() => portalCaller(firstSession).portal.me()),
    "UNAUTHORIZED",
  );
  check(
    "the new session works",
    (await loadPortalSession(
      db,
      `${portalCookieName()}=${reset.sessionToken}`,
    )) !== null,
  );
  check(
    "an outstanding link is retired by the reset",
    (await peekToken(db, outstanding.token)) === null,
  );
  const oldPassword = await verifySignIn(db, {
    email: user.email,
    password: GOOD,
    ...FACTS,
  });
  check("the old password no longer works", !oldPassword.ok);
  takeEmits();
}

// ---------------------------------------------------------------------------
// 3. Races: single-use token, concurrent fifth attempt

async function races() {
  section("3. races");
  const user = await newPortalUser("race");
  await grant(user.id, companyA.id, holderA.id);
  const t = await emailedToken(user.id, "SET_PASSWORD");
  const [a, b] = await Promise.all([
    setPasswordWithToken(db, { token: t.token, password: GOOD, ...FACTS }),
    setPasswordWithToken(db, { token: t.token, password: GOOD_3, ...FACTS }),
  ]);
  for (const r of [a, b]) if (r.ok) SECRETS.push(r.sessionToken);
  eq(
    "two concurrent consumes of one link: exactly one succeeds",
    [a, b].filter((r) => r.ok).length,
    1,
  );
  check(
    "the other answers EXPIRED",
    [a, b].some((r) => !r.ok && r.reason === "EXPIRED"),
  );
  eq("exactly one session exists", await liveSessions(user.id), 1);
  eq("exactly one PASSWORD_SET", await logCount(user.id, "PASSWORD_SET"), 1);
  const winner = a.ok ? GOOD : GOOD_3;
  const stored = await db.portalUser.findUniqueOrThrow({
    where: { id: user.id },
  });
  check(
    "the stored hash is the winner's password",
    await bcrypt.compare(winner, stored.passwordHash ?? ""),
  );
  takeEmits();

  // Concurrent fifth and sixth wrong attempts: exactly one lock, one notice.
  await db.portalUser.update({
    where: { id: user.id },
    data: { failedSignIns: 4, lockedUntil: null, lockNoticeSentAt: null },
  });
  const results = await Promise.all([
    verifySignIn(db, { email: user.email, password: WRONG, ...FACTS }),
    verifySignIn(db, { email: user.email, password: WRONG, ...FACTS }),
    verifySignIn(db, { email: user.email, password: WRONG, ...FACTS }),
  ]);
  check(
    "all three concurrent wrong attempts refused",
    results.every((r) => !r.ok),
  );
  eq(
    "exactly one ACCOUNT_LOCKED",
    await logCount(user.id, "ACCOUNT_LOCKED"),
    1,
  );
  const notices = takeEmits();
  eq(
    "exactly one lock notice",
    notices.filter((n) => n.kind === "LOCKED").length,
    1,
  );
  const row = await db.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  check(
    "locked with the counter at 0 (the late attempts did not count)",
    row.lockedUntil !== null && row.failedSignIns === 0,
  );

  // A sign-in that compared against the old hash cannot win after a reset.
  await db.portalUser.update({
    where: { id: user.id },
    data: { lockedUntil: null, failedSignIns: 0 },
  });
  const reset = await emailedToken(user.id, "RESET_PASSWORD");
  const [signIn, setPw] = await Promise.all([
    verifySignIn(db, { email: user.email, password: winner, ...FACTS }),
    setPasswordWithToken(db, {
      token: reset.token,
      password: GOOD_2,
      ...FACTS,
    }),
  ]);
  if (signIn.ok) SECRETS.push(signIn.sessionToken);
  if (setPw.ok) SECRETS.push(setPw.sessionToken);
  check("the reset succeeded", setPw.ok);
  eq(
    "whatever the order, only the reset's session is live",
    await liveSessions(user.id),
    1,
  );
  takeEmits();
}

// ---------------------------------------------------------------------------
// 4. Expired links, sessions ending

async function expiry() {
  section("4. expired links and sessions");
  const { user, sessionToken } = await withPassword("expiry");
  const past = new Date(Date.now() - 61 * 60_000);
  const old = await emailedToken(user.id, "RESET_PASSWORD", { now: past });
  check(
    "an expired link is not shown",
    (await peekToken(db, old.token)) === null,
  );
  const r = await setPasswordWithToken(db, {
    token: old.token,
    password: GOOD_3,
    ...FACTS,
  });
  check("an expired link is EXPIRED", !r.ok && r.reason === "EXPIRED");
  check(
    "and the job cannot mint it any more",
    (await mintTokenForDelivery(db, old.tokenId)) === null,
  );
  const unchanged = await db.portalUser.findUniqueOrThrow({
    where: { id: user.id },
  });
  check(
    "the password is unchanged",
    await bcrypt.compare(GOOD, unchanged.passwordHash ?? ""),
  );
  const invite = await emailedToken(user.id, "SET_PASSWORD", {
    now: new Date(Date.now() - 7 * 24 * 60 * 60_000 - 1_000),
  });
  check(
    "an invitation older than 7 days is not shown",
    (await peekToken(db, invite.token)) === null,
  );
  const fresh = await emailedToken(user.id, "SET_PASSWORD");
  check(
    "an invitation of 7 days is valid just before its end",
    (await peekToken(
      db,
      fresh.token,
      new Date(fresh.expiresAt.getTime() - 1_000),
    )) !== null,
  );
  // A re-minted link: only the latest email's link works.
  const remint = await mintTokenForDelivery(db, fresh.tokenId);
  if (remint) SECRETS.push(remint.token);
  check(
    "after a re-mint the earlier link is dead",
    (await peekToken(db, fresh.token)) === null &&
      remint !== null &&
      (await peekToken(db, remint.token)) !== null,
  );
  // A newer token of the same purpose retires the older one.
  const newer = await emailedToken(user.id, "SET_PASSWORD");
  check(
    "issuing a newer invitation retires the older one",
    remint !== null &&
      (await peekToken(db, remint.token)) === null &&
      (await peekToken(db, newer.token)) !== null,
  );

  const cookie = `${portalCookieName()}=${sessionToken}`;
  const session = await db.portalSession.findFirstOrThrow({
    where: { portalUserId: user.id, revokedAt: null },
  });
  check(
    "the session is valid now",
    (await loadPortalSession(db, cookie)) !== null,
  );
  const idle = new Date(
    session.lastSeenAt.getTime() + 24 * 60 * 60_000 + 1_000,
  );
  check(
    "24 h 1 s without use: refused",
    (await loadPortalSession(db, cookie, idle)) === null,
  );
  const end = new Date(session.expiresAt.getTime() + 1_000);
  check(
    "after 7 days: refused",
    (await loadPortalSession(db, cookie, end)) === null,
  );
  check(
    "a cookie under another name is ignored",
    (await loadPortalSession(db, `__Host-portal_session=${sessionToken}`)) ===
      null,
  );
  check("sign-out revokes", await revokeSession(db, session.id));
  check(
    "after sign-out the cookie is refused",
    (await loadPortalSession(db, cookie)) === null,
  );
  check("a second sign-out is a no-op", !(await revokeSession(db, session.id)));
  takeEmits();
}

// ---------------------------------------------------------------------------
// 5. Change password

async function change() {
  section("5. change password (signed in)");
  const { user, sessionToken } = await withPassword("change");
  const other = await verifySignIn(db, {
    email: user.email,
    password: GOOD,
    ...FACTS,
  });
  if (other.ok) SECRETS.push(other.sessionToken);
  const caller = portalCaller(sessionToken);
  const wrong = await errorOf(() =>
    caller.portal.changePassword({
      currentPassword: WRONG,
      newPassword: GOOD_2,
    }),
  );
  check(
    "a wrong current password is refused",
    wrong?.code === "BAD_REQUEST" && /incorrect/.test(wrong.message),
  );
  check(
    "and the message carries no password",
    !PASSWORDS.some((p) => wrong?.message.includes(p)),
  );
  eq(
    "a wrong current password counts toward the lock",
    (await db.portalUser.findUniqueOrThrow({ where: { id: user.id } }))
      .failedSignIns,
    1,
  );
  const weak = await errorOf(() =>
    caller.portal.changePassword({
      currentPassword: GOOD,
      newPassword: "short",
    }),
  );
  check(
    "a weak new password is refused with its reason",
    weak?.code === "BAD_REQUEST" && /12 characters/.test(weak.message),
  );
  const pending = await emailedToken(user.id, "RESET_PASSWORD");
  const done = await caller.portal.changePassword({
    currentPassword: GOOD,
    newPassword: GOOD_2,
  });
  check("the change succeeds", done.ok === true);
  check(
    "this session stays signed in",
    (await codeOf(() => caller.portal.me())) === "OK",
  );
  eq("every other session is revoked", await liveSessions(user.id), 1);
  check(
    "an outstanding reset link is retired",
    (await peekToken(db, pending.token)) === null,
  );
  const emails = takeEmits();
  check(
    "a password-changed email is queued",
    emails.some((e) => e.kind === "PASSWORD_CHANGED"),
  );
  const row = await db.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  check(
    "the new password is stored and the counter cleared",
    (await bcrypt.compare(GOOD_2, row.passwordHash ?? "")) &&
      row.failedSignIns === 0,
  );
  // Locked: the right current password is refused.
  await db.portalUser.update({
    where: { id: user.id },
    data: { lockedUntil: new Date(Date.now() + 10 * 60_000) },
  });
  const direct = await changePassword(db, {
    portalUserId: user.id,
    sessionId: "none",
    currentPassword: GOOD_2,
    newPassword: GOOD_3,
    ...FACTS,
  });
  check(
    "during a lock the change is refused",
    !direct.ok && direct.reason === "REFUSED",
  );
  takeEmits();
}

// ---------------------------------------------------------------------------
// 6. Disabled user, neutral answers, throttle

async function neutralAndThrottle() {
  section("6. disabled user, neutral answers, throttle");
  const { user: disabled } = await withPassword("disabled");
  const disabledSessionsBefore = await liveSessions(disabled.id);
  await db.portalAccess.updateMany({
    where: { portalUserId: disabled.id },
    data: { status: "DISABLED" },
  });
  const noPassword = await newPortalUser("nopw");
  await grant(noPassword.id, companyA.id, holderA.id);
  const { user: known } = await withPassword("known");
  const unknownEmail = `${EMAIL_PREFIX}nobody.${randomUUID().slice(0, 8)}@example.com`;

  const shapes: Record<string, unknown> = {};
  const timings: Record<string, number> = {};
  const attempt = async (label: string, email: string, password: string) => {
    const t0 = performance.now();
    shapes[label] = await verifySignIn(db, { email, password, ...FACTS });
    timings[label] = performance.now() - t0;
  };
  await attempt("unknown address", unknownEmail, GOOD);
  await attempt("malformed address", "not-an-email", GOOD);
  await attempt("no password yet", noPassword.email, GOOD);
  await attempt("wrong password", known.email, WRONG);
  await attempt("disabled, right password", disabled.email, GOOD);
  for (const [label, shape] of Object.entries(shapes)) {
    check(
      `sign-in refusal is { ok: false } only: ${label}`,
      JSON.stringify(shape) === JSON.stringify({ ok: false }),
    );
  }
  const values = Object.values(timings);
  const min = Math.min(...values);
  const max = Math.max(...values);
  check(
    "every refusal ran a cost-12 bcrypt comparison (comparable timing)",
    min > 50 && max < min * 3 + 100,
    JSON.stringify(timings),
  );
  eq(
    "the disabled user's right password created no session",
    await liveSessions(disabled.id),
    disabledSessionsBefore,
  );
  const disabledRow = await db.portalUser.findUniqueOrThrow({
    where: { id: disabled.id },
  });
  eq(
    "a right password with no ACTIVE access is not counted as wrong",
    disabledRow.failedSignIns,
    0,
  );

  // Reset requests: the same answer for everyone; email only when due.
  const auth = portalCaller(null, { origin: null }).portalAuth;
  takeEmits();
  const answers = [
    await auth.requestReset({ email: unknownEmail }),
    await auth.requestReset({ email: "not-an-email" }),
    await auth.requestReset({ email: disabled.email }),
  ];
  check(
    "requestReset answers { ok: true } for unknown, malformed and disabled",
    answers.every((a) => JSON.stringify(a) === JSON.stringify({ ok: true })),
  );
  eq("and queues no email for them", takeEmits().length, 0);
  // Timing: the answer takes as long whether or not a token is issued.
  const median = (xs: number[]) =>
    [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
  const resetTiming = async (email: string) => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await auth.requestReset({ email });
      times.push(performance.now() - t0);
    }
    return median(times);
  };
  const timedKnown = await newPortalUser("timed");
  await grant(timedKnown.id, companyA.id, holderA.id);
  const resetTimes = {
    unknown: await resetTiming(unknownEmail),
    disabled: await resetTiming(disabled.email),
    known: await resetTiming(timedKnown.email),
  };
  eq("the known address got its three reset emails", takeEmits().length, 3);
  const rMin = Math.min(...Object.values(resetTimes));
  const rMax = Math.max(...Object.values(resetTimes));
  check(
    "requestReset takes as long for unknown, disabled and known addresses",
    rMin >= 245 && rMax - rMin < 60,
    JSON.stringify(resetTimes),
  );
  const setupAnswer = await auth.requestReset({
    email: `  ${noPassword.email.toUpperCase()} `,
  });
  check(
    "a user without a password gets the same answer",
    JSON.stringify(setupAnswer) === JSON.stringify({ ok: true }),
  );
  eq("and a reset link (it completes the invitation)", takeEmits().length, 1);
  eq(
    "a disabled user's token can no longer be used",
    await (async () => {
      const t = await emailedToken(disabled.id, "SET_PASSWORD");
      const r = await setPasswordWithToken(db, {
        token: t.token,
        password: GOOD_3,
        ...FACTS,
      });
      return !r.ok && r.reason === "EXPIRED";
    })(),
    true,
  );

  // Throttle: 3 in 15 minutes, 10 in 24 hours.
  const throttled = await newPortalUser("throttle");
  await grant(throttled.id, companyA.id, holderA.id);
  takeEmits();
  for (let i = 0; i < 4; i++) {
    await auth.requestReset({ email: throttled.email });
  }
  eq(
    "three reset emails in 15 minutes, the fourth is dropped",
    takeEmits().length,
    3,
  );
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    await requestPasswordReset(db, {
      email: throttled.email,
      requestIp: FACTS.ip,
      now: new Date(t0 + (16 + i * 16) * 60_000),
    });
  }
  eq(
    "ten in 24 hours, then nothing (spaced 16 minutes apart)",
    takeEmits().length,
    7,
  );
  const tokenCount = await db.portalAccountToken.count({
    where: { portalUserId: throttled.id },
  });
  eq("exactly ten reset tokens were issued", tokenCount, 10);
  takeEmits();
}

// ---------------------------------------------------------------------------
// 7. No secret is stored or logged

async function noSecrets() {
  section("7. no token or password in any stored row");
  const ids = portalUserIds;
  const tables = [
    `SELECT row_to_json(t)::text AS j FROM "PortalUser" t WHERE id = ANY($1::text[])`,
    `SELECT row_to_json(t)::text AS j FROM "PortalSession" t WHERE "portalUserId" = ANY($1::text[])`,
    `SELECT row_to_json(t)::text AS j FROM "PortalAccountToken" t WHERE "portalUserId" = ANY($1::text[])`,
    `SELECT row_to_json(t)::text AS j FROM "PortalAccessLog" t WHERE "portalUserId" = ANY($1::text[])`,
    `SELECT row_to_json(t)::text AS j FROM "PortalAccess" t WHERE "portalUserId" = ANY($1::text[])`,
  ];
  let rows = 0;
  const leaks: string[] = [];
  for (const sql of tables) {
    const found = await db.$queryRawUnsafe<{ j: string }[]>(sql, ids);
    rows += found.length;
    for (const { j } of found) {
      for (const secret of [...SECRETS, ...PASSWORDS]) {
        if (j.includes(secret)) leaks.push(secret.slice(0, 6));
      }
    }
  }
  check(`${rows} portal rows scanned`, rows > 20);
  eq("no raw token, session value or password in them", leaks.length, 0);
  const payloads = JSON.stringify(allEmitted);
  check(
    `${allEmitted.length} queued account-email jobs`,
    allEmitted.length > 10,
  );
  check(
    "no job payload or singleton key carries a token, session value or password",
    ![...SECRETS, ...PASSWORDS].some((secret) => payloads.includes(secret)),
  );
  const printed = output.join("");
  check(`${printed.length} characters of output captured`, printed.length > 0);
  check(
    "no token, session value or password was printed",
    ![...SECRETS, ...PASSWORDS].some((secret) => printed.includes(secret)),
  );
  check(
    "job payloads carry row ids only",
    allEmitted.every(({ data }) =>
      Object.keys(data as object).every((k) =>
        ["kind", "tokenId", "accessId", "eventId"].includes(k),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------

async function cleanupPortal() {
  const sweep = await db.portalUser.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const ids = [...new Set([...portalUserIds, ...sweep.map((u) => u.id)])];
  await db.portalAccessLog.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalSession.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalAccountToken.deleteMany({
    where: { portalUserId: { in: ids } },
  });
  await db.portalAccess.deleteMany({ where: { portalUserId: { in: ids } } });
  await db.portalUser.deleteMany({ where: { id: { in: ids } } });
  const left =
    (await db.portalUser.count({ where: { id: { in: ids } } })) +
    (await db.portalAccessLog.count({ where: { portalUserId: { in: ids } } })) +
    (await db.portalSession.count({ where: { portalUserId: { in: ids } } })) +
    (await db.portalAccountToken.count({
      where: { portalUserId: { in: ids } },
    })) +
    (await db.portalAccess.count({ where: { portalUserId: { in: ids } } }));
  eq("portal rows removed", left, 0);
}

await runScenarios([
  ["setup", setup],
  ["invitation", invitationFlow],
  ["lockout", lockout],
  ["races", races],
  ["expiry", expiry],
  ["change password", change],
  ["neutral answers and throttle", neutralAndThrottle],
  ["no secrets", noSecrets],
  ["portal cleanup", cleanupPortal],
]);
