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
 * example.com`. Account-email jobs are captured instead of queued; sections
 * 1-7 stand in for the worker by calling `mintTokenForDelivery`, section 8
 * runs the worker (`deliverPortalAccountEmail`) with a capturing sender and
 * once with the real `sendMail`, which needs the local mail catcher (Mailpit:
 * SMTP on 1025, API on 8025). Section 9 calls the three route handlers
 * directly, and re-runs this file in a child process with an https base URL
 * for the `__Host-` / `Secure` cookie checks. Every row created, and the
 * caught email, is deleted at the end.
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
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { POST as setPasswordPOST } from "@/app/(portal)/portal/auth/set-password/route";
import { POST as signInPOST } from "@/app/(portal)/portal/auth/sign-in/route";
import { POST as signOutPOST } from "@/app/(portal)/portal/auth/sign-out/route";
import {
  deliverPortalAccountEmail,
  type PortalAccountEmailDeps,
} from "@/jobs/portal-account-email";
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
  SIGN_IN_REFUSED_MESSAGE,
  setPasswordWithToken,
  TOKEN_EXPIRED_MESSAGE,
  verifySignIn,
} from "@/server/portal/account";
import {
  type PortalAccountEmailData,
  portalAccountEmailJob,
} from "@/server/portal/account-email";
import { SIGN_IN_MIN_RESPONSE_MS } from "@/server/portal/http";
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
// 8. The account-email worker (P2b)

interface CapturedMail {
  to: string;
  subject: string;
  html: string;
  log: Record<string, unknown>;
}
const mails: CapturedMail[] = [];
const capture: PortalAccountEmailDeps = {
  send: ((options, log) => {
    mails.push({
      to: String(options.to),
      subject: String(options.subject),
      html: String(options.html),
      log: (log ?? {}) as Record<string, unknown>,
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

/** The set-password token in an email body, or null. */
function linkToken(html: string): string | null {
  const m = html.match(/\/portal\/set-password\/([A-Za-z0-9_-]{43})/);
  return m?.[1] ?? null;
}

async function tokenHashOf(tokenId: string) {
  return (
    await db.portalAccountToken.findUniqueOrThrow({ where: { id: tokenId } })
  ).tokenHash;
}

function issueOnly(
  portalUserId: string,
  purpose: "SET_PASSWORD" | "RESET_PASSWORD",
  now?: Date,
) {
  return db.$transaction((tx) =>
    issueToken(tx, { portalUserId, purpose, requestIp: FACTS.ip, now }),
  );
}

async function worker() {
  section("8. account-email worker");
  const user = await newPortalUser("mail");
  const access = await grant(user.id, companyA.id, holderA.id);
  const other = await newPortalUser("mail-other");
  const otherAccess = await grant(other.id, companyA.id, holderB.id);

  // INVITE: one email, the link works, nothing secret outside the body.
  const { tokenId } = await issueOnly(user.id, "SET_PASSWORD");
  const hashBefore = await tokenHashOf(tokenId);
  const r1 = await deliverPortalAccountEmail(
    { kind: "INVITE", tokenId },
    capture,
  );
  const [invite] = takeMails();
  eq("INVITE is sent", r1, "SENT");
  check("INVITE goes to the portal user's address", invite?.to === user.email);
  const t1 = linkToken(invite?.html ?? "");
  check("the invitation carries a set-password link", t1 !== null);
  if (t1) SECRETS.push(t1);
  eq(
    "the emailed link opens the form for that address",
    (await peekToken(db, t1))?.email,
    user.email,
  );
  check(
    "the token row was minted (its hash changed)",
    (await tokenHashOf(tokenId)) !== hashBefore,
  );
  check(
    "the subject names the company, not the link",
    invite?.subject ===
      `You have been invited to the ${companyA.name} investor portal` &&
      !invite.subject.includes(t1 ?? "@@"),
    invite?.subject,
  );
  check(
    "the body names the holder and the 7-day expiry",
    (invite?.html ?? "").includes("Holder A") &&
      (invite?.html ?? "").includes("7 days"),
  );
  check(
    "INVITE log context: kind, company and holder given explicitly",
    invite?.log.kind === "portal.invite" &&
      invite.log.companyId === companyA.id &&
      invite.log.stakeholderId === holderA.id &&
      invite.log.relatedType === "portalAccess" &&
      invite.log.relatedId === access.id,
    JSON.stringify(invite?.log),
  );
  check(
    "the log context carries no token",
    !JSON.stringify(invite?.log).includes(t1 ?? "@@"),
  );

  // A second delivery (a retry) mints again: only the latest link works.
  const r2 = await deliverPortalAccountEmail(
    { kind: "INVITE", tokenId },
    capture,
  );
  const [again] = takeMails();
  const t2 = linkToken(again?.html ?? "");
  if (t2) SECRETS.push(t2);
  check(
    "a retried INVITE sends a new link",
    r2 === "SENT" && t2 !== null && t2 !== t1,
  );
  check("the earlier link no longer works", (await peekToken(db, t1)) === null);

  // An accessId of another user is ignored: the email names this user's holder.
  const r3 = await deliverPortalAccountEmail(
    { kind: "INVITE", tokenId, accessId: otherAccess.id },
    capture,
  );
  const [foreign] = takeMails();
  const t3 = linkToken(foreign?.html ?? "");
  if (t3) SECRETS.push(t3);
  check(
    "INVITE with another user's accessId names this user's own holder",
    r3 === "SENT" &&
      foreign?.to === user.email &&
      foreign.log.stakeholderId === holderA.id &&
      !(foreign.html ?? "").includes("Holder B"),
    JSON.stringify(foreign?.log),
  );

  // A used token: nothing is sent, nothing is minted.
  const set = await setPasswordWithToken(db, {
    token: t3,
    password: GOOD,
    ...FACTS,
  });
  check("the latest link sets the password", set.ok);
  if (set.ok) SECRETS.push(set.sessionToken);
  const changed = takeEmits();
  const usedHash = await tokenHashOf(tokenId);
  eq(
    "a used token: nothing sent",
    await deliverPortalAccountEmail({ kind: "INVITE", tokenId }, capture),
    "TOKEN_UNUSABLE",
  );
  check(
    "a used token is not minted again",
    (await tokenHashOf(tokenId)) === usedHash && takeMails().length === 0,
  );

  // An expired token.
  const old = await issueOnly(
    user.id,
    "RESET_PASSWORD",
    new Date(Date.now() - 2 * 60 * 60_000),
  );
  eq(
    "an expired token: nothing sent",
    await deliverPortalAccountEmail(
      { kind: "RESET", tokenId: old.tokenId },
      capture,
    ),
    "TOKEN_UNUSABLE",
  );
  eq("no email for the expired token", takeMails().length, 0);

  // RESET: 60 minutes, no company named, no holder matched by address.
  const reset = await issueOnly(user.id, "RESET_PASSWORD");
  eq(
    "RESET is sent",
    await deliverPortalAccountEmail(
      { kind: "RESET", tokenId: reset.tokenId },
      capture,
    ),
    "SENT",
  );
  const [resetMail] = takeMails();
  const t4 = linkToken(resetMail?.html ?? "");
  if (t4) SECRETS.push(t4);
  check(
    "the reset email carries a working link valid 60 minutes",
    t4 !== null &&
      (await peekToken(db, t4)) !== null &&
      (resetMail?.html ?? "").includes("60 minutes"),
  );
  check(
    "RESET log context: kind only, no company or holder",
    resetMail?.log.kind === "portal.password-reset" &&
      resetMail.log.companyId === undefined &&
      resetMail.log.stakeholderId === undefined,
    JSON.stringify(resetMail?.log),
  );
  eq(
    "RESET subject",
    resetMail?.subject,
    "Set a new password for the investor portal",
  );

  // PASSWORD_CHANGED from the set above: no link.
  const changedJob = changed.find((e) => e.kind === "PASSWORD_CHANGED");
  check(
    "setting the password queued PASSWORD_CHANGED",
    changedJob !== undefined,
  );
  if (changedJob) {
    eq(
      "PASSWORD_CHANGED is sent",
      await deliverPortalAccountEmail(changedJob, capture),
      "SENT",
    );
    const [pc] = takeMails();
    check(
      "the password-changed email carries no link",
      pc !== undefined &&
        !pc.html.includes("/portal/") &&
        !/href="https?:/.test(pc.html) &&
        pc.subject === "Your investor portal password was changed" &&
        pc.log.kind === "portal.password-changed",
    );
    eq(
      "an event id of another kind is not sent as LOCKED",
      await deliverPortalAccountEmail(
        { kind: "LOCKED", eventId: changedJob.eventId },
        capture,
      ),
      "NOT_FOUND",
    );
  }

  // LOCKED: five wrong passwords.
  for (let i = 0; i < 5; i++) {
    await verifySignIn(db, { email: user.email, password: WRONG, ...FACTS });
  }
  const lockJob = takeEmits().find((e) => e.kind === "LOCKED");
  check("the lock queued LOCKED", lockJob !== undefined);
  if (lockJob) {
    eq(
      "LOCKED is sent",
      await deliverPortalAccountEmail(lockJob, capture),
      "SENT",
    );
    const [lk] = takeMails();
    check(
      "the lock email says 15 minutes, how to reset, and has no link",
      lk?.html.includes("15 minutes") === true &&
        lk.html.includes("Forgot") &&
        !lk.html.includes("/portal/") &&
        lk.log.kind === "portal.account-locked",
    );
  }

  // ACCESS_ADDED: sign-in link, no token.
  eq(
    "ACCESS_ADDED is sent",
    await deliverPortalAccountEmail(
      { kind: "ACCESS_ADDED", accessId: access.id },
      capture,
    ),
    "SENT",
  );
  const [added] = takeMails();
  check(
    "ACCESS_ADDED links to the sign-in page only",
    added?.html.includes(`${BASE}/portal/sign-in`) === true &&
      linkToken(added.html) === null &&
      added.subject === "You now have access to Holder A" &&
      added.log.stakeholderId === holderA.id,
    added?.subject,
  );

  // No ACTIVE access (P9): nothing minted, nothing sent.
  await db.portalAccess.update({
    where: { id: access.id },
    data: { status: "DISABLED" },
  });
  const p9 = await issueOnly(user.id, "RESET_PASSWORD");
  const p9Hash = await tokenHashOf(p9.tokenId);
  eq(
    "RESET for a user without ACTIVE access: nothing sent",
    await deliverPortalAccountEmail(
      { kind: "RESET", tokenId: p9.tokenId },
      capture,
    ),
    "NO_ACTIVE_ACCESS",
  );
  check(
    "and the token was not minted",
    (await tokenHashOf(p9.tokenId)) === p9Hash && takeMails().length === 0,
  );
  eq(
    "ACCESS_ADDED for a disabled access: nothing sent",
    await deliverPortalAccountEmail(
      { kind: "ACCESS_ADDED", accessId: access.id },
      capture,
    ),
    "NO_ACTIVE_ACCESS",
  );
  await db.portalAccess.update({
    where: { id: access.id },
    data: { status: "ACTIVE" },
  });

  // Production with the mail catcher: nothing minted, nothing sent.
  const guard = await issueOnly(user.id, "RESET_PASSWORD");
  const guardHash = await tokenHashOf(guard.tokenId);
  const savedNodeEnv = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  let blocked: string;
  try {
    blocked = await deliverPortalAccountEmail(
      { kind: "RESET", tokenId: guard.tokenId },
      capture,
    );
  } finally {
    Object.assign(process.env, { NODE_ENV: savedNodeEnv });
  }
  eq("production with the mail catcher: nothing sent", blocked, "MAIL_BLOCKED");
  check(
    "and nothing minted",
    (await tokenHashOf(guard.tokenId)) === guardHash &&
      takeMails().length === 0,
  );

  // One real send through sendMail: the EmailLog row and the mail catcher.
  eq(
    "a real RESET send through sendMail",
    await deliverPortalAccountEmail({ kind: "RESET", tokenId: guard.tokenId }),
    "SENT",
  );
  const logs = await db.emailLog.findMany({
    where: { toAddress: user.email, kind: "portal.password-reset" },
  });
  check(
    "one EmailLog row, SENT, no company or holder",
    logs.length === 1 &&
      logs[0]?.status === "SENT" &&
      logs[0].companyId === null &&
      logs[0].stakeholderId === null,
    JSON.stringify(logs.map((l) => [l.status, l.companyId, l.stakeholderId])),
  );
  const caught = await mailCatcherBody(user.email);
  const t5 = caught === null ? null : linkToken(caught);
  if (t5) SECRETS.push(t5);
  check("the mail catcher received the reset email", t5 !== null);
  check("its link works", t5 !== null && (await peekToken(db, t5)) !== null);
  check(
    "the EmailLog row carries no token",
    t5 !== null && !JSON.stringify(logs).includes(t5),
  );
  check(
    "other user untouched",
    (await db.portalAccountToken.count({
      where: { portalUserId: other.id },
    })) === 0,
  );
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

// ---------------------------------------------------------------------------
// 9. Route handlers (P2b): Origin, cookie, next, neutral refusals, sign-out

function post(
  path: string,
  opts: {
    body?: unknown;
    raw?: string;
    origin?: string | null;
    cookie?: string;
    contentType?: string;
    base?: string;
  } = {},
) {
  const base = opts.base ?? BASE;
  const headers = new Headers({
    "content-type": opts.contentType ?? "application/json",
    "user-agent": FACTS.userAgent,
    "x-forwarded-for": FACTS.ip,
  });
  const origin = opts.origin === undefined ? base : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(`${base}${path}`, {
    method: "POST",
    headers,
    body:
      opts.raw ??
      (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
}

/** The portal session cookie's value from a response, or null. */
function sessionFrom(response: Response): string | null {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [name, value] = (pair ?? "").split("=");
    if (name === portalCookieName() && value) return value;
  }
  return null;
}

function cookieLine(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .find((l) => l.startsWith(`${portalCookieName()}=`)) ?? ""
  );
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const value = await fn();
  return [value, Date.now() - start];
}

async function handlers() {
  section("9. route handlers");
  const { user } = await withPassword("route");
  const sessionsBefore = await liveSessions(user.id);

  // Origin first (S17): missing, "null", foreign, other scheme or port.
  for (const [label, origin] of [
    ["no Origin", null],
    ["Origin: null", "null"],
    ["a foreign Origin", "https://evil.example"],
    ["another port", "http://localhost:3001"],
    ["another scheme", "https://localhost:3000"],
  ] as const) {
    const res = await signInPOST(
      post("/portal/auth/sign-in", {
        origin,
        body: { email: user.email, password: GOOD },
      }),
    );
    check(
      `sign-in with ${label} is refused 403, no cookie`,
      res.status === 403 && sessionFrom(res) === null,
    );
  }
  const afterOrigin = await db.portalUser.findUniqueOrThrow({
    where: { id: user.id },
  });
  check(
    "refused origins created no session and counted nothing",
    (await liveSessions(user.id)) === sessionsBefore &&
      afterOrigin.failedSignIns === 0,
  );
  for (const [name, handler, path] of [
    ["set-password", setPasswordPOST, "/portal/auth/set-password"],
    ["sign-out", signOutPOST, "/portal/auth/sign-out"],
  ] as const) {
    const res = await handler(
      post(path, { origin: "https://evil.example", body: {} }),
    );
    eq(`${name} with a foreign Origin is refused 403`, res.status, 403);
  }

  // Success: cookie attributes on http (5.2 "Cookie").
  const ok = await signInPOST(
    post("/portal/auth/sign-in", {
      body: {
        email: user.email.toUpperCase(),
        password: GOOD,
        next: "/portal/go/report/r1",
      },
    }),
  );
  const okBody = (await ok.json()) as { ok: boolean; next: string };
  const session = sessionFrom(ok);
  if (session) SECRETS.push(session);
  check(
    "sign-in answers 200 with the safe next",
    ok.status === 200 && okBody.ok && okBody.next === "/portal/go/report/r1",
    JSON.stringify(okBody),
  );
  const line = cookieLine(ok).toLowerCase();
  check(
    "cookie portal_session; HttpOnly; SameSite=Lax; Path=/; Max-Age 7 days; no Domain; not Secure on http",
    portalCookieName() === "portal_session" &&
      line.includes("httponly") &&
      line.includes("samesite=lax") &&
      line.includes("path=/") &&
      line.includes("max-age=604800") &&
      !line.includes("domain=") &&
      !line.includes("secure"),
    line.replace(session ?? "@@", "<value>"),
  );
  check(
    "Cache-Control: no-store",
    ok.headers.get("cache-control") === "no-store",
  );
  check(
    "the cookie is a live session of that user",
    session !== null &&
      (await loadPortalSession(db, `${portalCookieName()}=${session}`))
        ?.portalUser.id === user.id,
  );

  // Open-redirect attempts all become /portal (S16).
  for (const next of [
    "//evil.example",
    "https://evil.example/portal/",
    "/\\evil.example",
    "/portal/../login",
    "/portal//evil.example",
    "/portal/auth/sign-out",
    "/portal/sign-in?next=//evil.example",
    "/login",
    "/portal%2F..%2Flogin",
    "javascript:alert(1)",
  ]) {
    const res = await signInPOST(
      post("/portal/auth/sign-in", {
        body: { email: user.email, password: GOOD, next },
      }),
    );
    const body = (await res.json()) as { next?: string };
    const s = sessionFrom(res);
    if (s) SECRETS.push(s);
    eq(`next ${JSON.stringify(next)} becomes /portal`, body.next, "/portal");
  }

  // Every refusal: one status, one body, at least the floor (S10).
  const refusals: [string, NextRequest][] = [
    [
      "unknown address",
      post("/portal/auth/sign-in", {
        body: { email: `${EMAIL_PREFIX}nobody@example.com`, password: GOOD },
      }),
    ],
    [
      "wrong password",
      post("/portal/auth/sign-in", {
        body: { email: user.email, password: WRONG },
      }),
    ],
    [
      "no password field",
      post("/portal/auth/sign-in", { body: { email: user.email } }),
    ],
    ["malformed JSON", post("/portal/auth/sign-in", { raw: "{not json" })],
    [
      "a form body",
      post("/portal/auth/sign-in", {
        raw: `email=${user.email}&password=${GOOD}`,
        contentType: "application/x-www-form-urlencoded",
      }),
    ],
    [
      "an oversized body",
      post("/portal/auth/sign-in", {
        body: { email: user.email, password: GOOD, pad: "x".repeat(5000) },
      }),
    ],
  ];
  const shapes = new Set<string>();
  for (const [label, request] of refusals) {
    const [res, ms] = await timed(() => signInPOST(request));
    const body = await res.text();
    shapes.add(`${res.status} ${body}`);
    check(
      `${label}: 401, no cookie, not before ${SIGN_IN_MIN_RESPONSE_MS} ms`,
      res.status === 401 &&
        sessionFrom(res) === null &&
        ms >= SIGN_IN_MIN_RESPONSE_MS - 5,
      `${res.status} in ${ms} ms`,
    );
  }
  check(
    "every refusal has the same status and body",
    shapes.size === 1 &&
      [...shapes][0] ===
        `401 ${JSON.stringify({ ok: false, error: SIGN_IN_REFUSED_MESSAGE })}`,
    [...shapes].join(" | "),
  );
  await db.portalUser.update({
    where: { id: user.id },
    data: { failedSignIns: 0 },
  });

  // Timing: a known address with a wrong password and an unknown address.
  const known: number[] = [];
  const unknown: number[] = [];
  for (let i = 0; i < 3; i++) {
    known.push(
      (
        await timed(() =>
          signInPOST(
            post("/portal/auth/sign-in", {
              body: { email: user.email, password: WRONG },
            }),
          ),
        )
      )[1],
    );
    unknown.push(
      (
        await timed(() =>
          signInPOST(
            post("/portal/auth/sign-in", {
              body: {
                email: `${EMAIL_PREFIX}ghost${i}@example.com`,
                password: WRONG,
              },
            }),
          ),
        )
      )[1],
    );
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  check(
    "known and unknown addresses answer in the same time (within 100 ms)",
    Math.abs(avg(known) - avg(unknown)) < 100,
    `known ${known.join("/")} ms, unknown ${unknown.join("/")} ms`,
  );
  await db.portalUser.update({
    where: { id: user.id },
    data: { failedSignIns: 0 },
  });

  // Set password through the handler.
  const fresh = await newPortalUser("route-set");
  await grant(fresh.id, companyA.id, holderA.id);
  const link = await emailedToken(fresh.id, "SET_PASSWORD", {
    nextPath: "/portal/go/report/r9",
  });
  const setReq = (password: string, confirm: string) =>
    setPasswordPOST(
      post("/portal/auth/set-password", {
        body: { token: link.token, password, confirm },
      }),
    );
  for (const [label, pw, confirm, reason] of [
    ["a short password", "Short-pw-1", "Short-pw-1", "TOO_SHORT"],
    ["a common password", "password1234", "password1234", "COMMON"],
    ["a mismatched repeat", GOOD_2, `${GOOD_2}x`, "MISMATCH"],
    [
      "the email name",
      `${fresh.email.split("@")[0]}-Long-1`,
      `${fresh.email.split("@")[0]}-Long-1`,
      "CONTAINS_EMAIL_NAME",
    ],
  ] as const) {
    const res = await setReq(pw, confirm);
    const body = (await res.json()) as { reason?: string; error?: string };
    check(
      `${label}: 400 ${reason} with a sentence, no cookie`,
      res.status === 400 &&
        body.reason === reason &&
        typeof body.error === "string" &&
        sessionFrom(res) === null,
      JSON.stringify(body),
    );
  }
  check(
    "after the refusals the link still works",
    (await peekToken(db, link.token)) !== null,
  );
  const setOk = await setReq(GOOD_2, GOOD_2);
  const setBody = (await setOk.json()) as { ok: boolean; next: string };
  const setSession = sessionFrom(setOk);
  if (setSession) SECRETS.push(setSession);
  check(
    "a good password: 200, the token's next, a session cookie",
    setOk.status === 200 &&
      setBody.next === "/portal/go/report/r9" &&
      setSession !== null,
    JSON.stringify(setBody),
  );
  const again = await setReq(GOOD_3, GOOD_3);
  const againBody = (await again.json()) as { reason?: string; error?: string };
  check(
    "the same link again: 410 EXPIRED",
    again.status === 410 &&
      againBody.reason === "EXPIRED" &&
      againBody.error === TOKEN_EXPIRED_MESSAGE,
  );
  const bogus = await setPasswordPOST(
    post("/portal/auth/set-password", {
      body: { token: "x".repeat(43), password: GOOD_3, confirm: GOOD_3 },
    }),
  );
  eq("an unknown token: 410", bogus.status, 410);
  takeEmits();

  // Sign-out.
  const cookie = `${portalCookieName()}=${setSession}`;
  const before = await logCount(fresh.id, "SIGNED_OUT");
  const out = await signOutPOST(
    post("/portal/auth/sign-out", { cookie, body: {} }),
  );
  const clear = cookieLine(out).toLowerCase();
  check(
    "sign-out: 303 to /portal/sign-in",
    out.status === 303 && out.headers.get("location") === "/portal/sign-in",
  );
  check(
    "sign-out clears the cookie with the same attributes",
    clear.startsWith(`${portalCookieName()}=;`) &&
      clear.includes("max-age=0") &&
      clear.includes("httponly") &&
      clear.includes("samesite=lax") &&
      clear.includes("path=/"),
    clear,
  );
  check(
    "sign-out revokes the session",
    (await loadPortalSession(db, cookie)) === null,
  );
  eq(
    "SIGNED_OUT logged once",
    (await logCount(fresh.id, "SIGNED_OUT")) - before,
    1,
  );
  const out2 = await signOutPOST(
    post("/portal/auth/sign-out", { cookie, body: {} }),
  );
  check(
    "signing out again: the same 303, no second log row",
    out2.status === 303 &&
      (await logCount(fresh.id, "SIGNED_OUT")) - before === 1,
  );
  const anon = await signOutPOST(post("/portal/auth/sign-out", { body: {} }));
  eq("sign-out without a cookie: the same 303", anon.status, 303);

  // A duplicated cookie with two values is no session (parseCookie).
  const s1 = await verifySignIn(db, {
    email: fresh.email,
    password: GOOD_2,
    ...FACTS,
  });
  if (s1.ok) SECRETS.push(s1.sessionToken);
  const dup = `${portalCookieName()}=${s1.ok ? s1.sessionToken : ""}; ${portalCookieName()}=${"y".repeat(43)}`;
  await signOutPOST(post("/portal/auth/sign-out", { cookie: dup, body: {} }));
  check(
    "a doubled cookie signs nothing out",
    s1.ok &&
      (await loadPortalSession(
        db,
        `${portalCookieName()}=${s1.sessionToken}`,
      )) !== null,
  );

  // https: run the cookie checks in a child process whose base URL is https
  // (the env is read once per process).
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_BASE_URL: HTTPS_BASE,
        PORTAL_HTTPS_CHILD: "1",
        PORTAL_HTTPS_EMAIL: fresh.email,
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const resultLine = (child.stdout ?? "")
    .split("\n")
    .find((l) => l.startsWith("HTTPS_RESULT "));
  const results = resultLine
    ? (JSON.parse(resultLine.slice("HTTPS_RESULT ".length)) as [
        string,
        boolean,
        string,
      ][])
    : [];
  check(
    "the https child ran",
    results.length > 0,
    (child.stderr ?? "").slice(-400),
  );
  for (const [label, passed, detail] of results)
    check(`https: ${label}`, passed, detail);
  output.push(child.stdout ?? "", child.stderr ?? "");
}

const HTTPS_BASE = "https://portal.example.test";

/** Runs in the child process (PORTAL_HTTPS_CHILD=1) with an https base URL. */
async function httpsChild() {
  const results: [string, boolean, string][] = [];
  const add = (label: string, ok: boolean, detail = "") =>
    results.push([label, ok, detail]);
  try {
    const email = process.env.PORTAL_HTTPS_EMAIL ?? "";
    add(
      "cookie name is __Host-portal_session",
      portalCookieName() === "__Host-portal_session",
    );
    const plain = await signInPOST(
      post("/portal/auth/sign-in", {
        base: HTTPS_BASE,
        origin: "http://portal.example.test",
        body: { email, password: GOOD_2 },
      }),
    );
    add("an http Origin is refused for an https app", plain.status === 403);
    const res = await signInPOST(
      post("/portal/auth/sign-in", {
        base: HTTPS_BASE,
        body: { email, password: GOOD_2 },
      }),
    );
    const line = cookieLine(res).toLowerCase();
    const value = sessionFrom(res);
    add(
      "sign-in sets __Host-portal_session; Secure; HttpOnly; SameSite=Lax; Path=/; no Domain",
      res.status === 200 &&
        line.startsWith("__host-portal_session=") &&
        line.includes("; secure") &&
        line.includes("httponly") &&
        line.includes("samesite=lax") &&
        line.includes("path=/") &&
        !line.includes("domain="),
      line.replace((value ?? "@@").toLowerCase(), "<value>"),
    );
    const out = await signOutPOST(
      post("/portal/auth/sign-out", {
        base: HTTPS_BASE,
        cookie: `__Host-portal_session=${value}`,
        body: {},
      }),
    );
    const clear = cookieLine(out).toLowerCase();
    add(
      "sign-out clears it with Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age=0",
      out.status === 303 &&
        clear.startsWith("__host-portal_session=;") &&
        clear.includes("; secure") &&
        clear.includes("httponly") &&
        clear.includes("samesite=lax") &&
        clear.includes("path=/") &&
        clear.includes("max-age=0"),
      clear,
    );
    add(
      "and revokes the session",
      value !== null &&
        (await loadPortalSession(db, `__Host-portal_session=${value}`)) ===
          null,
    );
  } catch (error) {
    add(
      "child ran without error",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  console.log(`HTTPS_RESULT ${JSON.stringify(results)}`);
  await db.$disconnect();
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
  await db.emailLog.deleteMany({
    where: { toAddress: { startsWith: EMAIL_PREFIX } },
  });
  await deleteCaughtMail();
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

if (process.env.PORTAL_HTTPS_CHILD === "1") {
  await httpsChild();
} else {
  await runScenarios([
    ["setup", setup],
    ["invitation", invitationFlow],
    ["lockout", lockout],
    ["races", races],
    ["expiry", expiry],
    ["change password", change],
    ["neutral answers and throttle", neutralAndThrottle],
    ["account-email worker", worker],
    ["route handlers", handlers],
    ["no secrets", noSecrets],
    ["portal cleanup", cleanupPortal],
  ]);
}
