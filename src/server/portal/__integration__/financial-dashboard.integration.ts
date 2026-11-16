/**
 * The dashboard procedures (04-investor-portal.md 5.9 "Procedures", P33–P36,
 * P39; package P13b): `financialDashboard.live`, `.published`, `.status`,
 * `.restate` and `portal.financials.get`, through router callers, against
 * the local database. Not part of `vitest run`. Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/financial-dashboard.integration.ts
 *
 * Companies are named `zz-fin-dash-…`, addresses are `@example.com`. Every
 * release is portal-only (no email); pg-boss is not started (the filing job
 * is captured). Every row created is deleted at the end (portal users,
 * sessions, access-log rows, custom roles and team users included).
 *
 * Fixture (the 2026 history of financial-snapshots.integration.ts). Company
 * 1: A and B (Preferred Members), M (Common Member, insider), X (prospect).
 * Company 2: P (Preferred Member). Portal users: U1 → A and P (two
 * companies), U2 → A (a second person for the same holder), U3 → B, U4 → B
 * (disabled). Q1 is released to A and B, Q3 (which fills Q2) to B only.
 * Economics "today" is pinned to 2026-10-05.
 *
 * P17 (T-EXP-*): the Excel exports of the investor's and the team's views,
 * read back with ExcelJS and compared with the same view's answer.
 *
 * Oracle: `live` against `getPeriodEconomics` + `getPositions` (and the term
 * clock against `getTermClock`); `published` and `portal.financials.get`
 * against the stored rows; `status.drift` against what `restate` then
 * rewrites.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Session } from "next-auth";
import { reportFileJob } from "@/jobs/governance-report-file";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { todayInZone } from "@/lib/governance/dates";
import {
  RESTATE_REASON_MAX_LENGTH,
  RESTATE_REASON_MIN_LENGTH,
  SELF_HOLDER_ID,
} from "@/lib/llc/financial-dashboard-core";
import {
  monthEnd,
  monthsBetween,
  periodLabel,
} from "@/lib/llc/financial-periods";
import {
  aggregate,
  aggregateHolder,
  type FundMonth,
  fundMonthFromJson,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import {
  actor,
  check,
  companyRef,
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
import { getPeriodEconomics } from "@/server/llc/economics";
import {
  computeDistribution,
  finalizeDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { getPositions } from "@/server/llc/economics/ledger";
import { getTermClock } from "@/server/llc/economics/term";
import {
  RESTATE_REASON_MAX,
  RESTATE_REASON_MIN,
} from "@/server/portal/financial-snapshot-write";
import { createPortalSession, portalCookieName } from "@/server/portal/session";
import { createCallerFactory } from "@/trpc/api/trpc";
import { financialDashboardRouter } from "@/trpc/routers/financial-dashboard-router/router";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";
import { portalRouter } from "@/trpc/routers/portal-router/router";

setCompanyPrefix("zz-fin-dash-");
const EMAIL_PREFIX = "zz-fin-dash.";
const TODAY = "2026-10-05";
const Q1 = ["2026-01-01", "2026-02-01", "2026-03-01"];
const JAN_SEP = monthsBetween("2026-01-01", "2026-09-01");

const show = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    isDeepStrictEqual(actual, expected),
    `got ${show(actual)}, expected ${show(expected)}`,
  );
}

// pg-boss is not started: the filing job a release queues is captured.
(reportFileJob as { emit: unknown }).emit = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Fixture

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

function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  return 2n * (r < 0n ? -r : r) >= d ? q + (n < 0n ? -1n : 1n) : q;
}

async function revenue(
  c: TestCompany,
  month: string,
  receiptsCents: bigint,
  utilizationBps: number | null,
) {
  await db.revenuePeriod.create({
    data: {
      companyId: c.id,
      month: fromDateOnly(month),
      customerReceiptsCents: receiptsCents,
      passThroughFeesCents: receiptsCents / 50n,
      otherIncomeCents: 1_234n,
      utilizationBps,
      managementFeeBps: 500,
      managementFeeCents: roundDiv(
        (receiptsCents - receiptsCents / 50n) * 500n,
        10_000n,
      ),
      updatedById: "fin-dash-integration",
    },
  });
}

async function expense(
  c: TestCompany,
  on: string,
  category: "COLOCATION" | "POWER" | "EQUIPMENT_ACQUISITION" | "INSURANCE",
  cents: bigint,
  fundingSource: "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS" = "OPERATING_CASH",
) {
  await db.expenseEntry.create({
    data: {
      companyId: c.id,
      incurredOn: fromDateOnly(on),
      category,
      payee: `${category} vendor`,
      amountCents: cents,
      fundingSource,
      createdById: "fin-dash-integration",
    },
  });
}

const teamUserIds: string[] = [];

/** A team member with a custom role holding exactly `permissions`. */
async function customTeamContext(
  c: TestCompany,
  permissions: { subject: string; actions: string[] }[],
) {
  const user = await db.user.create({
    data: {
      name: "Custom",
      email: `${EMAIL_PREFIX}team.${randomUUID().slice(0, 8)}@example.com`,
    },
  });
  teamUserIds.push(user.id);
  const role = await db.customRole.create({
    data: {
      companyId: c.id,
      name: `Custom ${teamUserIds.length}`,
      permissions,
    },
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
    userAgent: "fin-dash-integration",
    headers: new Headers(),
  };
}

type TeamCtx = Awaited<ReturnType<typeof createAdmin>>["context"];
const dashboard = (ctx: TeamCtx) =>
  createCallerFactory(financialDashboardRouter)(ctx);

async function company1() {
  const c = await createCompany("one");
  const A = await newMember(c, "Alpha Preferred");
  const B = await newMember(c, "Bravo Preferred");
  const M = await newMember(c, "Mike Common", { isInsider: true });
  const X = await newMember(c, "Xray Prospect");
  await issueCommon(c, M.id, "100", "2026-01-05");
  await subscribeOn(c, A.id, usd(100_000), "2026-01-12");
  await subscribeOn(c, B.id, usd(250_000), "2026-02-10");
  const receipts = [18_000, 21_500, 24_000, 26_250, 0, 30_000, 31_000, 29_500];
  for (const [i, m] of JAN_SEP.entries()) {
    await revenue(c, m, usd(receipts[i] ?? 33_000), i % 3 === 1 ? null : 8_000);
  }
  await expense(c, "2026-01-20", "COLOCATION", usd(3_000));
  await expense(c, "2026-02-14", "POWER", usd(1_200.55));
  await expense(
    c,
    "2026-03-03",
    "EQUIPMENT_ACQUISITION",
    usd(20_000),
    "CAPITAL_CONTRIBUTIONS",
  );
  await expense(c, "2026-05-30", "INSURANCE", usd(2_400));
  await db.reserveEntry.create({
    data: {
      companyId: c.id,
      effectiveOn: fromDateOnly("2026-01-15"),
      kind: "MINIMUM_OPERATING",
      type: "ESTABLISH",
      amountCents: usd(50_000),
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      reason: "Minimum operating reserve (integration)",
      createdById: "fin-dash-integration",
    },
  });
  await db.managerPayment.create({
    data: {
      companyId: c.id,
      paidOn: fromDateOnly("2026-04-06"),
      payee: "Manager Payee LLC",
      amountCents: usd(1_500),
      category: "MANAGEMENT_FEE",
      createdById: "fin-dash-integration",
    },
  });
  setToday("2026-04-15");
  const input = { company: companyRef(c), actor };
  const draft = await inTx((tx) =>
    saveDistributionDraft(tx, {
      ...input,
      type: "OPERATING",
      periodStart: null,
      periodEnd: "2026-03-31",
      paymentDate: "2026-04-20",
      inputs: { type: "OPERATING" },
      notes: null,
    }),
  );
  const comp = await inTx((tx) =>
    computeDistribution(tx, companyRef(c), draft.id),
  );
  check(
    "fixture: the April distribution computes without blockers",
    comp.blockers.length === 0 && comp.amount > 0n,
    comp.blockers.map((b) => b.code).join(","),
  );
  await inTx((tx) =>
    finalizeDistribution(tx, {
      ...input,
      id: draft.id,
      expectedHash: comp.hash,
      solvencyConfirmed: true,
    }),
  );
  setToday(TODAY);
  await db.stakeholder.update({
    where: { id: X.id },
    data: { memberStatus: "PROSPECT" },
  });
  // The term clock: Operations started 2026-02-01, LOI days 30.
  await db.llcTerm.update({
    where: { companyId: c.id },
    data: {
      operationsCommencementDate: fromDateOnly("2026-02-01"),
      loiExtensionDays: 30,
    },
  });
  const admin = await createAdmin(c);
  return {
    c,
    A,
    B,
    M,
    X,
    admin: admin.context,
    reports: createCallerFactory(memberReportRouter)(admin.context),
    team: dashboard(admin.context),
  };
}

async function company2() {
  const c = await createCompany("two");
  const P = await newMember(c, "Papa Preferred");
  await subscribeOn(c, P.id, usd(80_000), "2026-01-20");
  for (const m of JAN_SEP) await revenue(c, m, usd(5_000), 7_500);
  setToday(TODAY);
  const admin = await createAdmin(c);
  return {
    c,
    P,
    admin: admin.context,
    reports: createCallerFactory(memberReportRouter)(admin.context),
    team: dashboard(admin.context),
  };
}

type Reports = Awaited<ReturnType<typeof company1>>["reports"];

async function quarterDraft(
  reports: Reports,
  companyId: string,
  quarter: 1 | 2 | 3,
) {
  const { publicId } = await reports.create({
    type: "QUARTERLY",
    fiscalYear: 2026,
    fiscalQuarter: quarter,
  });
  const row = await db.memberReport.findFirstOrThrow({
    where: { publicId, companyId },
  });
  // biome-ignore lint/suspicious/noExplicitAny: test fixture edits JSON
  const figures = JSON.parse(JSON.stringify(row.figures)) as any;
  figures.utilization.bps = 8_100;
  figures.managerPayments.confirmedNone = true;
  await reports.update({
    publicId,
    title: `Q${quarter} 2026`,
    figures,
    commentary: [
      {
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Quarter in review.", styles: {} }],
        children: [],
      },
    ],
  });
  return publicId;
}

const release = (reports: Reports, publicId: string, ids: string[]) =>
  reports.release({ publicId, stakeholderIds: ids, email: false });

// ---------------------------------------------------------------------------
// Portal users and callers

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
      invitedById: "fin-dash-integration",
    },
  });
}

async function portalFor(portalUserId: string) {
  const { token } = await createPortalSession(db, {
    portalUserId,
    ip: "203.0.113.7",
    userAgent: "fin-dash-integration",
    now: new Date(),
  });
  const headers = new Headers();
  headers.set("cookie", `${portalCookieName()}=${token}`);
  headers.set("x-trpc-source", "rsc");
  return createCallerFactory(portalRouter)({
    db,
    session: null,
    requestIp: "127.0.0.1",
    userAgent: "",
    headers,
  } as never);
}

type Portal = Awaited<ReturnType<typeof portalFor>>;
/** Every portal answer, for the scan for ids and names. */
const answers: { label: string; value: unknown }[] = [];

async function financials(label: string, p: Portal, access: string) {
  const value = await p.financials.get({ access });
  answers.push({ label, value });
  return value;
}

// ---------------------------------------------------------------------------
// Oracles

/** A live fund month against the services for that month (to today in the month in progress). */
async function liveAgainstServices(
  c: TestCompany,
  m: FundMonth,
): Promise<string[]> {
  const end = m.inProgress ? TODAY : monthEnd(m.month);
  const pe = await getPeriodEconomics(db, c.id, {
    periodStart: m.month,
    periodEnd: end,
  });
  const pos = (await getPositions(db, c.id, end)).positions;
  const tiers = { c: 0n, d: 0n, ep: 0n, ec: 0n };
  for (const i of pe.distributions.items) {
    tiers.c += i.tierC;
    tiers.d += i.tierD;
    tiers.ep += i.tierEPreferred;
    tiers.ec += i.tierECommon;
  }
  const pairs: [string, unknown, unknown][] = [
    ["asOf", m.asOf, end],
    ["grossRevenue", m.grossRevenue, pe.revenue.grossRevenue],
    ["otherIncome", m.otherIncome, pe.revenue.otherIncome],
    ["totalExpenses", m.totalExpenses, pe.expenses.total],
    ["operatingExpenses", m.operatingExpenses, pe.expenses.operating],
    ["capitalFundedExpenses", m.capitalFundedExpenses, pe.expenses.fromCapital],
    ["managementFeeAccrued", m.managementFeeAccrued, pe.managementFee.accrued],
    ["managementFeePaid", m.managementFeePaid, pe.managementFee.paid],
    [
      "managementFeeUnpaid",
      m.managementFeeUnpaid,
      pe.managementFee.unpaidAtEnd,
    ],
    ["reserveBalance", m.reserveBalance, pe.reserves.balanceAtEnd],
    ["availableCash", m.availableCash, pe.availableCashAtEnd.availableCash],
    ["distributions.gross", m.distributions.gross, pe.distributions.totalGross],
    ["distributions.preferredReturn", m.distributions.preferredReturn, tiers.c],
    ["distributions.returnOfCapital", m.distributions.returnOfCapital, tiers.d],
    ["distributions.residualCommon", m.distributions.residualCommon, tiers.ec],
    ["paidInCapital", m.paidInCapital, pos.totals.contributed],
    ["unreturnedCapital", m.unreturnedCapital, pos.totals.unreturned],
    ["preferredReturnUnpaid", m.preferredReturnUnpaid, pos.totals.unpaidReturn],
    [
      "utilizationBps",
      m.utilizationBps,
      pe.revenue.byMonth[0]?.utilizationBps ?? null,
    ],
  ];
  return pairs
    .filter(([, a, b]) => a !== b)
    .map(([k, a, b]) => `${k}: ${String(a)} ≠ ${String(b)}`);
}

/** The current stored fund rows through `through`, as JSON, oldest first. */
async function storedFund(companyId: string, through: string) {
  const rows = await db.financialSnapshot.findMany({
    where: {
      companyId,
      supersededAt: null,
      month: { lte: fromDateOnly(through) },
    },
    orderBy: { month: "asc" },
  });
  return rows
    .filter((r) => monthEnd(toDateOnly(r.month)) <= through)
    .map((r) => r.data);
}

/** One holder's current stored rows through `through`, as JSON with holderId "self". */
async function storedHolder(
  companyId: string,
  stakeholderId: string,
  through: string,
) {
  const rows = await db.holderFinancialSnapshot.findMany({
    where: {
      companyId,
      stakeholderId,
      supersededAt: null,
      month: { lte: fromDateOnly(through) },
    },
    orderBy: { month: "asc" },
  });
  return rows
    .filter((r) => monthEnd(toDateOnly(r.month)) <= through)
    .map((r) => ({ ...(r.data as object), holderId: SELF_HOLDER_ID }));
}

// ---------------------------------------------------------------------------
// Scenarios

let w1: Awaited<ReturnType<typeof company1>>;
let w2: Awaited<ReturnType<typeof company2>>;
const pub: { q1?: string; q3?: string; p1?: string } = {};
const acc = { u1A: "", u1P: "", u2A: "", u3B: "", u4B: "" };
let U1: Portal;
let U2: Portal;
let U3: Portal;
let U4: Portal;

async function beforeRelease() {
  section("T-DASH-1: before any release");
  w1 = await company1();
  w2 = await company2();
  const { c, A, B, P } = { ...w1, P: w2.P };
  const u1 = await newPortalUser("u1");
  const u2 = await newPortalUser("u2");
  const u3 = await newPortalUser("u3");
  const u4 = await newPortalUser("u4");
  acc.u1A = (await grant(u1.id, c.id, A.id)).publicId;
  acc.u1P = (await grant(u1.id, w2.c.id, P.id)).publicId;
  acc.u2A = (await grant(u2.id, c.id, A.id)).publicId;
  acc.u3B = (await grant(u3.id, c.id, B.id)).publicId;
  acc.u4B = (await grant(u4.id, c.id, B.id, "DISABLED")).publicId;
  U1 = await portalFor(u1.id);
  U2 = await portalFor(u2.id);
  U3 = await portalFor(u3.id);
  U4 = await portalFor(u4.id);

  const empty = await financials("A before release", U1, acc.u1A);
  eq("portal: no published period, nothing at all", empty, {
    publishedThrough: null,
    inceptionMonth: null,
    timeZone: "America/Denver",
    fundMonths: [],
    holderMonths: [],
    periods: [],
    restatements: [],
    termClock: null,
  });
  const st = await w1.team.status();
  eq(
    "status before any release: no snapshot, no drift (books closed by the April distribution)",
    st,
    { snapshotThrough: null, booksClosedThrough: "2026-03-31", drift: [] },
  );
  const pubView = await w1.team.published();
  check(
    "published (team) before any release: no months, the term clock",
    pubView.fundMonths.length === 0 &&
      pubView.publishedThrough === null &&
      pubView.termClock !== null,
  );

  section("T-DASH-2: live equals the existing economics services");
  const live = await w1.team.live();
  const months = live.fundMonths.map((m) => m.month);
  eq(
    "live: January through October (the month in progress)",
    months,
    monthsBetween("2026-01-01", "2026-10-01"),
  );
  eq("live: inception January", live.inceptionMonth, "2026-01-01");
  eq("live: figures as of today", live.publishedThrough, TODAY);
  check(
    "live: only October is in progress",
    live.fundMonths.every((m) => m.inProgress === (m.month === "2026-10-01")),
  );
  eq(
    "live: no holder months, no restatements",
    [live.holderMonths, live.restatements],
    [[], []],
  );
  for (const json of live.fundMonths) {
    const m = fundMonthFromJson(json);
    const diffs = await liveAgainstServices(c, m);
    check(
      `live ${m.month.slice(0, 7)} = getPeriodEconomics + getPositions`,
      diffs.length === 0,
      diffs.join("; "),
    );
  }
  check(
    "the oracle is not vacuous: April has the distribution and revenue",
    live.fundMonths.some(
      (m) =>
        m.month === "2026-04-01" &&
        m.distributions.gross > 0 &&
        m.grossRevenue > 0,
    ),
  );
  const clock = await getTermClock(db, c.id);
  eq("live: term clock = getTermClock", live.termClock, {
    operationsStart: clock.operationsCommencementDate,
    targetSaleDate: clock.effectiveTargetSaleDate,
  });
  check(
    "the term clock is not vacuous (OCD 2026-02-01 + 5 years + 30 LOI days)",
    live.termClock?.targetSaleDate === "2031-03-03",
    String(live.termClock?.targetSaleDate),
  );
  const may = await w1.team.live({ through: "2026-05-15" });
  eq(
    "live through 2026-05-15: January–May, all ended",
    may.fundMonths.map((m) => [m.month, m.inProgress]),
    monthsBetween("2026-01-01", "2026-05-01").map((m) => [m, false]),
  );
  eq(
    "live through mid-May: figures through the May month end",
    may.publishedThrough,
    "2026-05-31",
  );
  eq(
    "live through a later date is cut at today",
    (await w1.team.live({ through: "2027-06-30" })).fundMonths.length,
    10,
  );
  eq(
    "live through a date before inception: no months",
    (await w1.team.live({ through: "2025-12-31" })).fundMonths,
    [],
  );
  eq(
    "live: periods are the ended quarters (no report yet)",
    live.periods.map((p) => [p.key, p.reportId]),
    [
      ["2026-Q1", null],
      ["2026-Q2", null],
      ["2026-Q3", null],
    ],
  );
  const bad = await errorOf(() => w1.team.live({ through: "2026-02-30" }));
  eq("live: an impossible date is BAD_REQUEST", bad?.code, "BAD_REQUEST");
}

async function afterReleases() {
  section("T-DASH-3: releases; published equals the stored rows");
  const { c, A, B, reports, team } = w1;
  pub.q1 = await quarterDraft(reports, c.id, 1);
  await release(reports, pub.q1, [A.id, B.id]);
  pub.q3 = await quarterDraft(reports, c.id, 3);
  await release(reports, pub.q3, [B.id]);
  const teamView = await team.published();
  eq(
    "team published: through 2026-09-30",
    teamView.publishedThrough,
    "2026-09-30",
  );
  eq(
    "team published: fund months = the stored current rows",
    teamView.fundMonths,
    await storedFund(c.id, "2026-09-30"),
  );
  eq("team published: no holder months", teamView.holderMonths, []);
  eq(
    "team published: periods with the team's released reports",
    teamView.periods.map((p) => [p.key, p.reportId]),
    [
      ["2026-Q1", pub.q1],
      ["2026-Q2", null],
      ["2026-Q3", pub.q3],
    ],
  );
  eq("team published: no restatement yet", teamView.restatements, []);

  section("T-DASH-4: portal visibility through-date per holder (P33, P36)");
  const a = await financials("A after Q1/Q3", U1, acc.u1A);
  eq("A: published through 2026-03-31", a.publishedThrough, "2026-03-31");
  eq(
    "A: fund months January–March although April–September exist",
    a.fundMonths.map((m) => m.month),
    Q1,
  );
  eq(
    "A: fund months = the stored rows",
    a.fundMonths,
    await storedFund(c.id, "2026-03-31"),
  );
  eq(
    "A: holder months = A's stored rows, holderId replaced",
    a.holderMonths,
    await storedHolder(c.id, A.id, "2026-03-31"),
  );
  check(
    "A: three own months, each parses, holderId 'self'",
    a.holderMonths.length === 3 &&
      a.holderMonths.every(
        (h) => holderMonthFromJson(h).holderId === SELF_HOLDER_ID,
      ),
  );
  eq("A: periods = Q1 with its report", a.periods, [
    {
      key: "2026-Q1",
      grain: "quarter",
      start: "2026-01-01",
      end: "2026-03-31",
      reportId: pub.q1,
    },
  ]);
  eq("A: inception January", a.inceptionMonth, "2026-01-01");
  eq("A: term clock as the team sees it", a.termClock, teamView.termClock);
  const a2 = await financials("A through U2", U2, acc.u2A);
  eq("a second person with access to A gets the same answer", a2, a);
  const b = await financials("B after Q1/Q3", U3, acc.u3B);
  eq("B: published through 2026-09-30", b.publishedThrough, "2026-09-30");
  eq(
    "B: nine fund months",
    b.fundMonths.map((m) => m.month),
    JAN_SEP,
  );
  eq(
    "B: holder months = B's stored rows (February–September)",
    b.holderMonths,
    await storedHolder(c.id, B.id, "2026-09-30"),
  );
  eq(
    "B: periods Q1, Q2 (no report of its own), Q3",
    b.periods.map((p) => [p.key, p.reportId]),
    [
      ["2026-Q1", pub.q1],
      ["2026-Q2", null],
      ["2026-Q3", pub.q3],
    ],
  );
  check(
    "A and B: different holder records (no sharing)",
    !isDeepStrictEqual(a.holderMonths, b.holderMonths.slice(0, 3)),
  );

  section("T-DASH-5: published({ asHolder }) equals portal.financials.get");
  eq(
    "asHolder A = A's portal answer",
    await team.published({ asHolder: A.id }),
    a,
  );
  eq(
    "asHolder B = B's portal answer",
    await team.published({ asHolder: B.id }),
    b,
  );
  eq(
    "asHolder M (in no report): nothing",
    (await team.published({ asHolder: w1.M.id })).fundMonths,
    [],
  );
  const foreign = await errorOf(() => team.published({ asHolder: w2.P.id }));
  eq("asHolder of another company: NOT_FOUND", foreign?.code, "NOT_FOUND");
  const readOnly = await customTeamContext(c, [
    { subject: "llc-financials", actions: ["read"] },
  ]);
  const ro = dashboard(readOnly);
  check(
    "a role with llc-financials: read sees live, published and status",
    (await ro.published()).fundMonths.length === 9 &&
      (await ro.status()).snapshotThrough === "2026-09-30" &&
      (await ro.live()).fundMonths.length === 10,
  );
  const noPortal = await errorOf(() => ro.published({ asHolder: A.id }));
  eq("asHolder without portal: read is FORBIDDEN", noPortal?.code, "FORBIDDEN");
  const withPortal = dashboard(
    await customTeamContext(c, [
      { subject: "llc-financials", actions: ["read"] },
      { subject: "portal", actions: ["read"] },
    ]),
  );
  eq(
    "asHolder with llc-financials: read and portal: read",
    await withPortal.published({ asHolder: A.id }),
    a,
  );
  const noFin = dashboard(
    await customTeamContext(c, [{ subject: "portal", actions: ["read"] }]),
  );
  eq(
    "without llc-financials: read, published is refused",
    (await errorOf(() => noFin.published()))?.code,
    "UNAUTHORIZED",
  );
  eq(
    "without llc-financials: read, status is refused",
    (await errorOf(() => noFin.status()))?.code,
    "UNAUTHORIZED",
  );

  section("T-DASH-6: accesses, cross-holder and cross-company");
  eq(
    "disabled access (U4 → B): NOT_FOUND",
    (await errorOf(() => U4.financials.get({ access: acc.u4B })))?.code,
    "NOT_FOUND",
  );
  eq(
    "U1 with B's access id: NOT_FOUND",
    (await errorOf(() => U1.financials.get({ access: acc.u3B })))?.code,
    "NOT_FOUND",
  );
  const p0 = await financials("P before company 2 releases", U1, acc.u1P);
  eq("P (company 2, nothing released): empty", p0.fundMonths, []);
  pub.p1 = await quarterDraft(w2.reports, w2.c.id, 1);
  await release(w2.reports, pub.p1, [w2.P.id]);
  const p = await financials("P after company 2 Q1", U1, acc.u1P);
  eq(
    "P: company 2's own fund rows only",
    p.fundMonths,
    await storedFund(w2.c.id, "2026-03-31"),
  );
  check(
    "P: company 2's paid-in, not company 1's",
    p.fundMonths.every(
      (m) => m.paidInCapital === 0 || m.paidInCapital === 8_000_000,
    ) && p.fundMonths.some((m) => m.paidInCapital === 8_000_000),
  );
  eq(
    "company 1's A unchanged by company 2's release",
    await financials("A after company 2 release", U1, acc.u1A),
    a,
  );
  eq(
    "company 2's team published shows company 2 only",
    (await w2.team.published()).fundMonths,
    await storedFund(w2.c.id, "2026-03-31"),
  );
  const logs = await db.portalAccessLog.count({
    where: { portalUserId: { in: portalUserIds } },
  });
  eq("portal.financials.get writes no access-log row", logs, 0);
}

async function unpublishRepublish() {
  section("T-DASH-7: unpublish empties A's dashboard, republish restores it");
  const { reports } = w1;
  const before = await financials("A before unpublish", U1, acc.u1A);
  await reports.unpublish({ publicId: pub.q1 as string });
  const gone = await financials("A after unpublish", U1, acc.u1A);
  eq(
    "A: nothing after Q1 is unpublished",
    [gone.publishedThrough, gone.fundMonths, gone.holderMonths, gone.termClock],
    [null, [], [], null],
  );
  const b = await financials("B after Q1 unpublish", U3, acc.u3B);
  eq("B keeps 2026-09-30", b.publishedThrough, "2026-09-30");
  eq(
    "B: Q1 has no report link while Q1 is unpublished",
    b.periods.map((p) => [p.key, p.reportId]),
    [
      ["2026-Q1", null],
      ["2026-Q2", null],
      ["2026-Q3", pub.q3],
    ],
  );
  await reports.publish({ publicId: pub.q1 as string });
  eq(
    "A: republishing Q1 restores the same answer",
    await financials("A after republish", U1, acc.u1A),
    before,
  );
}

// ---------------------------------------------------------------------------
// P17: the Excel exports of the dashboard views

type ExcelJsModule = typeof import("exceljs");
type Sheet = import("exceljs").Worksheet;

async function loadExcelJs(): Promise<ExcelJsModule> {
  const mod = (await import("exceljs")) as ExcelJsModule & {
    default?: ExcelJsModule;
  };
  return mod.default ?? mod;
}

/** A downloaded workbook read back: each sheet as plain values (formula cells: their result). */
async function readBook(base64: string) {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, "base64") as never);
  const sheets = new Map<string, { ws: Sheet; rows: unknown[][] }>();
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const out: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const v = cell.value as unknown;
        out[c - 1] =
          v !== null && typeof v === "object" && "formula" in (v as object)
            ? (v as { result: unknown }).result
            : v;
      });
      rows[n - 1] = out;
    });
    sheets.set(ws.name, { ws, rows });
  });
  return { wb, sheets };
}

type Book = Awaited<ReturnType<typeof readBook>>;

function sheetOf(book: Book, name: string) {
  const s = book.sheets.get(name);
  if (!s) throw new Error(`no sheet ${name}`);
  return s;
}

/** The header row of a sheet (its first cell "Figure" or "Month"). */
function headerOf(book: Book, name: string): unknown[] {
  const { rows } = sheetOf(book, name);
  return rows.find((r) => r?.[0] === "Figure" || r?.[0] === "Month") ?? [];
}

/** The row whose first cell is `label`. */
function rowOf(book: Book, name: string, label: string): unknown[] {
  const { rows } = sheetOf(book, name);
  const r = rows.find((x) => x?.[0] === label);
  if (!r) throw new Error(`no row ${label} in ${name}`);
  return r;
}

/** The rows from the header down (the title block excluded). */
function tableOf(book: Book, name: string): unknown[][] {
  const { rows } = sheetOf(book, name);
  return rows.slice(
    rows.findIndex((r) => r?.[0] === "Figure" || r?.[0] === "Month"),
  );
}

/** Every text and number of the workbook (for the isolation scan). */
function bookValues(book: Book): { texts: string[]; numbers: number[] } {
  const texts: string[] = [];
  const numbers: number[] = [];
  for (const { rows } of book.sheets.values()) {
    for (const r of rows) {
      for (const v of r ?? []) {
        if (typeof v === "string") texts.push(v);
        if (typeof v === "number") numbers.push(v);
      }
    }
  }
  texts.push(
    book.wb.creator ?? "",
    book.wb.title ?? "",
    ...[...book.sheets.keys()],
  );
  return { texts, numbers };
}

const dollars = (cents: number | bigint) => Number(cents) / 100;

function exportLogs() {
  return db.portalAccessLog.count({
    where: {
      portalUserId: { in: portalUserIds },
      event: "FINANCIALS_EXPORTED",
    },
  });
}

const YEAR_2026 = {
  grain: "quarter" as const,
  from: "2026-01-01",
  to: "2026-12-01",
};

async function exportsScenario() {
  section("T-EXP-1: the investor's export equals the investor's view (P17)");
  const { c, A, B, M, X, reports, team } = w1;
  const aView = await U1.financials.get({ access: acc.u1A });
  const aFund = aView.fundMonths.map(fundMonthFromJson);
  const aMine = aView.holderMonths.map(holderMonthFromJson);
  const logs0 = await exportLogs();
  const fundFile = await U1.financials.exportXlsx({
    access: acc.u1A,
    view: "fund",
    ...YEAR_2026,
    focus: "2026-Q1",
    compare: "previous",
  });
  check(
    "fund export: an .xlsx file named by the company and the period",
    /^zz-fin-dash-one-[a-z0-9]+-financials-2026-Q1\.xlsx$/.test(
      fundFile.fileName,
    ),
    fundFile.fileName,
  );
  const fund = await readBook(fundFile.base64);
  eq(
    "fund export: the five fund sheets",
    [...fund.sheets.keys()],
    ["Summary", "Income", "Expenses", "Distributions", "Capital"],
  );
  eq(
    "fund export: `to` past the published-through date is clamped (Q1 only)",
    headerOf(fund, "Income"),
    ["Figure", "Basis", "Q1 2026", "Total"],
  );
  const [q1] = aggregate(aFund, "quarter", {
    from: "2026-01-01",
    to: "2026-03-01",
  });
  const q1v = q1?.values;
  if (!q1v) throw new Error("fixture: Q1 has values");
  eq(
    "Income: Gross Revenue of Q1 and its Total = aggregate of the investor's months",
    rowOf(fund, "Income", "Gross Revenue").slice(2, 4),
    [dollars(q1v.grossRevenue), dollars(q1v.grossRevenue)],
  );
  eq(
    "Income: net operating income and Available Cash",
    [
      rowOf(
        fund,
        "Income",
        "Net operating income (before reserves and distributions)",
      )[2],
      rowOf(fund, "Income", "Available Cash")[2],
    ],
    [dollars(q1v.netOperatingIncome), dollars(q1v.availableCash)],
  );
  eq(
    "Capital: paid-in capital at the end of Q1",
    rowOf(fund, "Capital", "Paid-in capital")[2],
    dollars(q1v.paidInCapital),
  );
  eq(
    "Summary: the selected period Q1 2026, compared with Q4 2025",
    headerOf(fund, "Summary"),
    ["Figure", "Q1 2026", "Q4 2025", "Change", "Change %", "Notes"],
  );
  eq(
    "Summary: the Gross Revenue tile",
    rowOf(fund, "Summary", "Gross Revenue")[1],
    dollars(q1v.grossRevenue),
  );
  check(
    "fund export: no month after March 2026 anywhere",
    !/(Apr|May|Jun|Jul|Aug|Sep|Oct) 2026|Q[234] 2026/.test(
      bookValues(fund).texts.join("\n"),
    ),
  );
  const incomeSheet = sheetOf(fund, "Income");
  const income = incomeSheet.ws;
  const headerRow = incomeSheet.rows.findIndex((r) => r?.[0] === "Figure") + 1;
  const revRow =
    incomeSheet.rows.findIndex((r) => r?.[0] === "Gross Revenue") + 1;
  const total = income.getCell(revRow, 4).value as { formula?: string };
  eq(
    "Income: the Total is a SUM formula over the period columns",
    total.formula,
    `SUM(C${revRow}:C${revRow})`,
  );
  const frozen = income.views[0] as {
    state?: string;
    xSplit?: number;
    ySplit?: number;
  };
  eq(
    "Income: money format; header and first column frozen",
    [
      income.getCell(revRow, 3).numFmt,
      frozen.state,
      frozen.xSplit,
      frozen.ySplit,
    ],
    ['"$"#,##0.00;[Red]("$"#,##0.00)', "frozen", 1, headerRow],
  );
  eq(
    "Income: printed landscape, one page wide, header repeated",
    [
      income.pageSetup.orientation,
      income.pageSetup.fitToWidth,
      income.pageSetup.printTitlesRow,
    ],
    ["landscape", 1, `${headerRow}:${headerRow}`],
  );
  eq("one FINANCIALS_EXPORTED row", (await exportLogs()) - logs0, 1);
  const row = await db.portalAccessLog.findFirstOrThrow({
    where: {
      portalUserId: { in: portalUserIds },
      event: "FINANCIALS_EXPORTED",
    },
    orderBy: { createdAt: "desc" },
  });
  const accessRow = await db.portalAccess.findFirstOrThrow({
    where: { publicId: acc.u1A },
  });
  eq(
    "the log row: A's access in company 1, target 'financials' named by the view",
    [
      row.companyId,
      row.stakeholderId,
      row.portalAccessId,
      row.targetType,
      row.targetId,
      row.targetName,
    ],
    [
      c.id,
      A.id,
      accessRow.id,
      "financials",
      null,
      "Financials, Q1 2026, by quarter",
    ],
  );

  section("T-EXP-2: My investment: the holder's own figures, nobody else's");
  const mineFile = await U1.financials.exportXlsx({
    access: acc.u1A,
    view: "mine",
    grain: "month",
    from: "2026-01-01",
    to: "2026-09-01",
    focus: "2026-03",
    compare: "previous",
  });
  const mine = await readBook(mineFile.base64);
  eq(
    "mine export: the holder's sheets",
    [...mine.sheets.keys()],
    ["Summary", "My investment", "My distributions", "My contributions"],
  );
  eq("mine export: January to March only", headerOf(mine, "My investment"), [
    "Figure",
    "Basis",
    "Jan 2026",
    "Feb 2026",
    "Mar 2026",
    "Total",
  ]);
  const calendar = aFund.map((m) => ({
    month: m.month,
    inProgress: m.inProgress,
  }));
  const [aQ1] = aggregateHolder(aMine, calendar, "quarter", {
    from: "2026-01-01",
    to: "2026-03-01",
  });
  eq(
    "My investment: paid in (end) and contributions (sum) = A's records",
    [
      rowOf(mine, "My investment", "Paid in")[5],
      rowOf(mine, "My investment", "Contributions")[5],
    ],
    [
      dollars(aQ1?.values?.paidIn ?? 0n),
      dollars(aQ1?.values?.contributions ?? 0n),
    ],
  );
  check(
    "the fixture is not vacuous: A paid in $100,000",
    aQ1?.values?.paidIn === 10_000_000n,
  );
  const bJson = await U3.financials.get({ access: acc.u3B });
  const bOwn = bJson.holderMonths.map(holderMonthFromJson);
  const bOnlyNumbers = [
    ...new Set(
      bOwn.flatMap((h) => [
        dollars(h.paidIn),
        dollars(h.committed),
        Number(h.preferredUnits) / 1_000_000,
      ]),
    ),
  ].filter((n) => n !== 0);
  check(
    "the scan is not vacuous: B has its own amounts ($250,000 paid in)",
    bOnlyNumbers.includes(250_000),
    bOnlyNumbers.join(", "),
  );
  for (const [label, book] of [
    ["fund export", fund],
    ["mine export", mine],
  ] as const) {
    const { texts, numbers } = bookValues(book);
    const all = texts.join("\n");
    const names = [A, B, M, X, w2.P].flatMap((h) => [h.id, h.name, h.email]);
    const hits = names.filter((s) => s && all.includes(s));
    check(
      `${label}: no holder's name, id or email (A's own included)`,
      hits.length === 0,
      hits.join(", "),
    );
    const leaked = bOnlyNumbers.filter((n) => numbers.includes(n));
    check(
      `${label}: none of B's own amounts`,
      leaked.length === 0,
      leaked.join(", "),
    );
  }

  section("T-EXP-3: refusals write no log row");
  const before = await exportLogs();
  const req = { view: "fund" as const, ...YEAR_2026 };
  eq(
    "a range wholly after the published-through date: NOT_FOUND",
    (
      await errorOf(() =>
        U1.financials.exportXlsx({
          access: acc.u1A,
          ...req,
          from: "2026-04-01",
        }),
      )
    )?.code,
    "NOT_FOUND",
  );
  eq(
    "a disabled access: NOT_FOUND",
    (await errorOf(() => U4.financials.exportXlsx({ access: acc.u4B, ...req })))
      ?.code,
    "NOT_FOUND",
  );
  eq(
    "another person's access id: NOT_FOUND",
    (await errorOf(() => U1.financials.exportXlsx({ access: acc.u3B, ...req })))
      ?.code,
    "NOT_FOUND",
  );
  eq(
    "a reversed range: BAD_REQUEST",
    (
      await errorOf(() =>
        U1.financials.exportXlsx({
          access: acc.u1A,
          ...req,
          from: "2026-09-01",
          to: "2026-01-01",
        }),
      )
    )?.code,
    "BAD_REQUEST",
  );
  await reports.unpublish({ publicId: pub.q1 as string });
  eq(
    "after Q1 is unpublished, A's export is NOT_FOUND",
    (await errorOf(() => U1.financials.exportXlsx({ access: acc.u1A, ...req })))
      ?.code,
    "NOT_FOUND",
  );
  eq("no log row for any refusal", (await exportLogs()) - before, 0);
  await reports.publish({ publicId: pub.q1 as string });
  const again = await readBook(
    (
      await U1.financials.exportXlsx({
        access: acc.u1A,
        ...req,
        focus: "2026-Q1",
      })
    ).base64,
  );
  eq(
    "republished: the same Income sheet as before",
    sheetOf(again, "Income").rows,
    sheetOf(fund, "Income").rows,
  );

  section("T-EXP-4: B's export: nine months; another company's holder");
  const bBook = await readBook(
    (
      await U3.financials.exportXlsx({
        access: acc.u3B,
        view: "fund",
        grain: "month",
        from: "2026-01-01",
        to: "2027-06-01",
      })
    ).base64,
  );
  eq("B: January to September, by month", headerOf(bBook, "Income").slice(2), [
    ...JAN_SEP.map((m) => periodLabel(m.slice(0, 7))),
    "Total",
  ]);
  const bFund = bJson.fundMonths.map(fundMonthFromJson);
  const sepRevenue = bFund.find((m) => m.month === "2026-09-01")?.grossRevenue;
  eq(
    "B: September revenue = B's view",
    rowOf(bBook, "Income", "Gross Revenue")[10],
    dollars(sepRevenue ?? 0n),
  );
  const pView = await U1.financials.get({ access: acc.u1P });
  const pBook = await readBook(
    (
      await U1.financials.exportXlsx({
        access: acc.u1P,
        view: "fund",
        grain: "quarter",
        from: "2026-01-01",
        to: "2026-03-01",
      })
    ).base64,
  );
  const [pQ1] = aggregate(pView.fundMonths.map(fundMonthFromJson), "quarter", {
    from: "2026-01-01",
    to: "2026-03-01",
  });
  eq(
    "P (company 2): company 2's figures under company 2's name",
    [
      rowOf(pBook, "Income", "Gross Revenue")[2],
      rowOf(pBook, "Capital", "Paid-in capital")[2],
      pBook.wb.creator,
    ],
    [dollars(pQ1?.values?.grossRevenue ?? 0n), 80_000, w2.c.name],
  );
  check(
    "P's export names nothing of company 1",
    !bookValues(pBook).texts.join("\n").includes(c.name),
  );

  section("T-EXP-5: the team's export of each source (P39)");
  const teamLogs = await exportLogs();
  const live = await team.live();
  const liveBook = await readBook(
    (
      await team.exportXlsx({
        source: "live",
        view: "fund",
        grain: "month",
        from: "2026-01-01",
        to: "2026-10-01",
        focus: "2026-10",
      })
    ).base64,
  );
  eq(
    "live: January to October, October in progress",
    headerOf(liveBook, "Income").slice(2),
    [
      ...monthsBetween("2026-01-01", "2026-09-01").map((m) =>
        periodLabel(m.slice(0, 7)),
      ),
      "Oct 2026 (in progress)",
      "Total",
    ],
  );
  const [liveYtd] = aggregate(live.fundMonths.map(fundMonthFromJson), "year", {
    from: "2026-01-01",
    to: "2026-10-01",
  });
  eq(
    "live: the Total of Gross Revenue = the ledger's year to date",
    rowOf(liveBook, "Income", "Gross Revenue")[12],
    dollars(liveYtd?.values?.grossRevenue ?? 0n),
  );
  const published = await readBook(
    (
      await team.exportXlsx({
        source: "published",
        view: "fund",
        ...YEAR_2026,
      })
    ).base64,
  );
  eq(
    "published: Q1–Q3 (every published month), no holder sheet",
    [headerOf(published, "Income").slice(2), [...published.sheets.keys()]],
    [
      ["Q1 2026", "Q2 2026", "Q3 2026", "Total"],
      ["Summary", "Income", "Expenses", "Distributions", "Capital"],
    ],
  );
  const previewMine = await readBook(
    (
      await team.exportXlsx({
        source: "published",
        asHolder: A.id,
        view: "mine",
        grain: "month",
        from: "2026-01-01",
        to: "2026-09-01",
        focus: "2026-03",
      })
    ).base64,
  );
  eq(
    "preview as A: My investment equals A's own export",
    tableOf(previewMine, "My investment"),
    tableOf(mine, "My investment"),
  );
  check(
    "preview names the previewed holder (the team may see it)",
    bookValues(previewMine).texts.some((t) => t.includes(A.name)),
  );
  const previewFund = await readBook(
    (
      await team.exportXlsx({
        source: "published",
        asHolder: A.id,
        view: "fund",
        ...YEAR_2026,
      })
    ).base64,
  );
  eq(
    "preview as A, fund: A's published-through date (Q1 only), not the team's",
    headerOf(previewFund, "Income").slice(2),
    ["Q1 2026", "Total"],
  );
  const refused = (fn: () => Promise<unknown>) =>
    errorOf(fn).then((e) => e?.code);
  eq(
    "without asHolder, 'mine' is refused (the team's export has no My investment)",
    await refused(() =>
      team.exportXlsx({ source: "published", view: "mine", ...YEAR_2026 }),
    ),
    "BAD_REQUEST",
  );
  eq(
    "live with a holder is refused",
    await refused(() =>
      team.exportXlsx({
        source: "live",
        asHolder: A.id,
        view: "fund",
        ...YEAR_2026,
      }),
    ),
    "BAD_REQUEST",
  );
  eq(
    "asHolder of another company: NOT_FOUND",
    await refused(() =>
      team.exportXlsx({
        source: "published",
        asHolder: w2.P.id,
        view: "fund",
        ...YEAR_2026,
      }),
    ),
    "NOT_FOUND",
  );
  const ro = dashboard(
    await customTeamContext(c, [
      { subject: "llc-financials", actions: ["read"] },
    ]),
  );
  const roFile = await ro.exportXlsx({
    source: "published",
    view: "fund",
    ...YEAR_2026,
  });
  eq(
    "llc-financials: read exports the published view (as the admin does)",
    tableOf(await readBook(roFile.base64), "Income"),
    tableOf(published, "Income"),
  );
  eq(
    "a preview export without portal: read is FORBIDDEN",
    await refused(() =>
      ro.exportXlsx({
        source: "published",
        asHolder: A.id,
        view: "mine",
        ...YEAR_2026,
      }),
    ),
    "FORBIDDEN",
  );
  const noFin = dashboard(
    await customTeamContext(c, [{ subject: "portal", actions: ["read"] }]),
  );
  eq(
    "without llc-financials: read the export is refused",
    await refused(() =>
      noFin.exportXlsx({ source: "published", view: "fund", ...YEAR_2026 }),
    ),
    "UNAUTHORIZED",
  );
  const c2 = await readBook(
    (
      await w2.team.exportXlsx({
        source: "published",
        view: "fund",
        ...YEAR_2026,
      })
    ).base64,
  );
  eq(
    "company 2's team export: company 2 only (Q1, its paid-in)",
    [
      headerOf(c2, "Income").slice(2),
      rowOf(c2, "Capital", "Paid-in capital")[2],
    ],
    [["Q1 2026", "Total"], 80_000],
  );
  eq(
    "team exports write no portal log row",
    (await exportLogs()) - teamLogs,
    0,
  );
}

async function driftAndRestate() {
  section("T-DASH-8: a back-dated change appears in status.drift");
  const { c, A, B, team } = w1;
  const aBefore = await financials(
    "A before the back-dated change",
    U1,
    acc.u1A,
  );
  await db.llcTerm.update({
    where: { companyId: c.id },
    data: { booksClosedThrough: null },
  });
  await expense(c, "2026-02-20", "POWER", usd(777));
  // A holder-only difference: A's stored January record is altered by hand
  // (the fund record of January is not).
  const janA = await db.holderFinancialSnapshot.findFirstOrThrow({
    where: {
      companyId: c.id,
      stakeholderId: A.id,
      month: fromDateOnly("2026-01-01"),
      supersededAt: null,
    },
  });
  const janData = janA.data as { netPaid: number };
  await db.holderFinancialSnapshot.update({
    where: { id: janA.id },
    data: { data: { ...(janA.data as object), netPaid: janData.netPaid + 1 } },
  });
  const st = await team.status();
  eq("status: books no longer closed", st.booksClosedThrough, null);
  eq("status: snapshots through 2026-09-30", st.snapshotThrough, "2026-09-30");
  const jan = st.drift.find((d) => d.month === "2026-01-01");
  check(
    "status: January drifts for A's record only (fund fields empty)",
    jan !== undefined &&
      jan.fields.length === 0 &&
      jan.holders.length === 1 &&
      jan.holders[0]?.stakeholderId === A.id &&
      jan.holders[0]?.name === "Alpha Preferred" &&
      isDeepStrictEqual(jan.holders[0]?.fields, ["netPaid"]),
    show(jan),
  );
  const feb = st.drift.find((d) => d.month === "2026-02-01");
  check(
    "status: February drifts, naming the expense fields",
    feb?.published != null &&
      feb.fields.includes("totalExpenses") &&
      feb.fields.includes("operatingExpenses") &&
      feb.ledger.totalExpenses - feb.published.totalExpenses === 77_700,
    show(feb?.fields),
  );
  check(
    "status: every drift month is in the published range",
    st.drift.every((d) => d.month >= "2026-01-01" && d.month <= "2026-09-01"),
  );
  const aStill = await financials("A after the back-dated change", U1, acc.u1A);
  eq(
    "portal: A still sees the old fund figures (snapshots, not the ledger)",
    aStill.fundMonths,
    aBefore.fundMonths,
  );
  eq(
    "portal: A's February-March records unchanged; no restatement note",
    [aStill.holderMonths.slice(1), aStill.restatements],
    [aBefore.holderMonths.slice(1), []],
  );

  section("T-DASH-9: restate permissions and validation");
  eq(
    "the browser-safe reason bounds equal the write module's",
    [RESTATE_REASON_MIN_LENGTH, RESTATE_REASON_MAX_LENGTH],
    [RESTATE_REASON_MIN, RESTATE_REASON_MAX],
  );
  const finOnly = dashboard(
    await customTeamContext(c, [
      { subject: "llc-financials", actions: ["read", "update"] },
    ]),
  );
  const govOnly = dashboard(
    await customTeamContext(c, [
      { subject: "llc-financials", actions: ["read"] },
      { subject: "governance", actions: ["read", "update"] },
    ]),
  );
  const input = {
    fromMonth: "2026-01-01",
    toMonth: "2026-09-01",
    reason: "Back-dated power invoice for February",
  };
  eq(
    "restate without governance: update is refused",
    (await errorOf(() => finOnly.restate(input)))?.code,
    "UNAUTHORIZED",
  );
  eq(
    "restate without llc-financials: update is refused",
    (await errorOf(() => govOnly.restate(input)))?.code,
    "UNAUTHORIZED",
  );
  const refusals: [string, Parameters<typeof team.restate>[0], RegExp][] = [
    ["a short reason", { ...input, reason: "   short   " }, /10 to 500/],
    ["a reason over 500", { ...input, reason: "x".repeat(501) }, /10 to 500/],
    [
      "a month not given as its first day",
      { ...input, toMonth: "2026-09-30" },
      /first day/,
    ],
    [
      "from after to",
      { ...input, fromMonth: "2026-05-01", toMonth: "2026-04-01" },
      /must not be after/,
    ],
    [
      "a month after the latest snapshot",
      { ...input, toMonth: "2026-10-01" },
      /latest is 2026-09/,
    ],
    [
      "a range before inception",
      { ...input, fromMonth: "2025-06-01" },
      /no figures before 2026-01/,
    ],
  ];
  for (const [what, bad, msg] of refusals) {
    const e = await errorOf(() => team.restate(bad));
    check(
      `restate refuses ${what} (BAD_REQUEST)`,
      e?.code === "BAD_REQUEST" && msg.test(e.message),
      `${e?.code}: ${e?.message}`,
    );
  }
  const unknownKey = await errorOf(() =>
    team.restate({ ...input, companyId: w2.c.id } as never),
  );
  eq(
    "restate refuses an unknown key (companyId)",
    unknownKey?.code,
    "BAD_REQUEST",
  );
  eq(
    "no restatement written by a refusal",
    await db.audit.count({
      where: { companyId: c.id, action: "financials.restated" },
    }),
    0,
  );

  section("T-DASH-10: restate rewrites exactly the drift months; drift clears");
  const out = await team.restate(input);
  eq(
    "restated months = the drift months",
    out.months.map((m) => m.month),
    st.drift.map((d) => d.month),
  );
  check(
    "January: holder-only (no fund field), one holder; February names the expense",
    out.months.some(
      (m) =>
        m.month === "2026-01-01" &&
        m.fundFields.length === 0 &&
        m.holdersChanged === 1 &&
        m.version === 2,
    ) &&
      out.months.some(
        (m) =>
          m.month === "2026-02-01" && m.fundFields.includes("totalExpenses"),
      ),
    show(out.months),
  );
  eq(
    "unchanged = the rest of the range",
    [...out.unchanged, ...out.months.map((m) => m.month)].sort(),
    JAN_SEP,
  );
  eq("status: drift is empty after restate", (await team.status()).drift, []);
  check(
    "the old rows still exist (superseded)",
    (await db.financialSnapshot.count({
      where: {
        companyId: c.id,
        month: fromDateOnly("2026-02-01"),
        supersededAt: { not: null },
      },
    })) === 1,
  );
  const restatedOn = todayInZone(new Date(), "America/Denver");
  const a = await financials("A after restate", U1, acc.u1A);
  const aFeb = a.fundMonths.find((m) => m.month === "2026-02-01");
  const oldFeb = aBefore.fundMonths.find((m) => m.month === "2026-02-01");
  check(
    "portal: A sees the new February figures",
    aFeb !== undefined &&
      oldFeb !== undefined &&
      aFeb.totalExpenses - oldFeb.totalExpenses === 77_700,
  );
  eq(
    "portal: A's January record is the ledger's again (the hand edit is gone)",
    a.holderMonths.find((h) => h.month === "2026-01-01")?.netPaid,
    janData.netPaid,
  );
  const aNotes = a.restatements.map((r) => r.month);
  check(
    "portal: A is told about January (its own record) and February (fund), dated today",
    aNotes.includes("2026-01-01") &&
      aNotes.includes("2026-02-01") &&
      a.restatements.every((r) => r.at === restatedOn) &&
      aNotes.every((m) => m <= "2026-03-01"),
    show(a.restatements),
  );
  const b = await financials("B after restate", U3, acc.u3B);
  const bNotes = b.restatements.map((r) => r.month);
  check(
    "portal: B is told about February but not about A's January",
    bNotes.includes("2026-02-01") && !bNotes.includes("2026-01-01"),
    show(b.restatements),
  );
  const teamNotes = (await team.published()).restatements.map((r) => r.month);
  check(
    "team published: every restated month (January included)",
    teamNotes.includes("2026-01-01") && teamNotes.includes("2026-02-01"),
  );
  eq(
    "asHolder A = A's portal answer after restate",
    await team.published({ asHolder: A.id }),
    a,
  );
  eq(
    "asHolder B = B's portal answer after restate",
    await team.published({ asHolder: B.id }),
    b,
  );
  const again = await errorOf(() => team.restate(input));
  check(
    "restating again is refused: nothing to restate",
    again?.code === "BAD_REQUEST" && /Nothing to restate/.test(again.message),
  );
  const audit = await db.audit.findMany({
    where: { companyId: c.id, action: "financials.restated" },
  });
  check(
    "one audit row, by the admin, with the reason",
    audit.length === 1 && (audit[0]?.summary ?? "").includes(input.reason),
    audit[0]?.summary ?? "none",
  );

  section("T-DASH-11: concurrent restatements through the router");
  await expense(c, "2026-05-12", "COLOCATION", usd(50));
  const mayVersions = await db.financialSnapshot.count({
    where: { companyId: c.id, month: fromDateOnly("2026-05-01") },
  });
  // May and every later month its Available Cash carries into.
  const mayInput = {
    fromMonth: "2026-05-01",
    toMonth: "2026-09-01",
    reason: "Back-dated colocation charge for May",
  };
  const [r1, r2] = await Promise.allSettled([
    team.restate(mayInput),
    team.restate(mayInput),
  ]);
  const ok = [r1, r2].filter((r) => r.status === "fulfilled");
  const ko = [r1, r2].filter((r) => r.status === "rejected");
  check(
    "one restates May–September, the other finds nothing to restate",
    ok.length === 1 &&
      ko.length === 1 &&
      /Nothing to restate/.test(
        String((ko[0] as PromiseRejectedResult).reason?.message),
      ),
    [r1, r2]
      .map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))
      .join(" | "),
  );
  const mayRows = await db.financialSnapshot.findMany({
    where: { companyId: c.id, month: fromDateOnly("2026-05-01") },
    orderBy: { version: "asc" },
  });
  eq(
    "May: one new version, only the newest current",
    mayRows.map((x) => `${x.version}:${x.supersededAt === null}`),
    mayRows.map((_x, i) => `${i + 1}:${i === mayVersions}`),
  );
  eq("May: exactly one row was added", mayRows.length, mayVersions + 1);
  eq("status: no drift after the race", (await team.status()).drift, []);
  eq(
    "A (through March) is not told about May",
    (await financials("A after May restate", U1, acc.u1A)).restatements.some(
      (r) => r.month === "2026-05-01",
    ),
    false,
  );

  section("T-DASH-12: another company is untouched");
  eq("company 2: no drift", (await w2.team.status()).drift, []);
  eq("company 2: no restatement", (await w2.team.published()).restatements, []);
  const c2restate = await errorOf(() =>
    w2.team.restate({
      fromMonth: "2026-02-01",
      toMonth: "2026-02-01",
      reason: "Nothing differs for company two",
    }),
  );
  check(
    "company 2 cannot restate company 1's months (nothing to restate there)",
    c2restate?.code === "BAD_REQUEST" &&
      /Nothing to restate/.test(c2restate.message),
  );
  void B;
}

async function answerScan() {
  section("T-DASH-13: no internal id or another holder's data in any answer");
  const { c, A, B, M, X } = w1;
  const reportIds = (
    await db.memberReport.findMany({
      where: { companyId: { in: [c.id, w2.c.id] } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const accessIds = (
    await db.portalAccess.findMany({
      where: { portalUserId: { in: portalUserIds } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const snapshotIds = (
    await db.financialSnapshot.findMany({
      where: { companyId: { in: [c.id, w2.c.id] } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const memberIds = (
    await db.member.findMany({
      where: { companyId: { in: [c.id, w2.c.id] } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const common = [
    c.id,
    w2.c.id,
    c.name,
    ...reportIds,
    ...accessIds,
    ...snapshotIds,
    ...memberIds,
    "Manager Payee LLC",
    "Back-dated",
    "restateReason",
    "frozenById",
  ];
  const holders: Record<string, { id: string; name: string; email: string }> = {
    A,
    B,
    M,
    X,
    P: w2.P,
  };
  check(
    "the scan has answers to read",
    answers.length >= 15,
    `${answers.length}`,
  );
  for (const { label, value } of answers) {
    const text = JSON.stringify(value);
    // Every holder's id (the viewer's own included) and every name and
    // address: a portal answer names nobody.
    const forbidden = [
      ...common,
      ...Object.values(holders).flatMap((h) => [h.id, h.name, h.email]),
    ];
    const hits = forbidden.filter((s) => text.includes(s));
    check(
      `${label}: no id, name or reason`,
      hits.length === 0,
      hits.join(", "),
    );
  }
}

async function cleanupPortal() {
  section("cleanup: portal users, sessions, custom roles, team users");
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
  await db.member.deleteMany({ where: { userId: { in: teamUserIds } } });
  await db.user.deleteMany({ where: { id: { in: teamUserIds } } });
  const left =
    (await db.portalUser.count({ where: { id: { in: portalUserIds } } })) +
    (await db.portalSession.count({
      where: { portalUserId: { in: portalUserIds } },
    })) +
    (await db.user.count({ where: { id: { in: teamUserIds } } }));
  eq("portal rows and custom team users removed", left, 0);
}

runScenarios([
  ["before release and live", beforeRelease],
  ["releases and visibility", afterReleases],
  ["unpublish and republish", unpublishRepublish],
  ["exports (P17)", exportsScenario],
  ["drift and restate", driftAndRestate],
  ["answer scan", answerScan],
  ["portal cleanup", cleanupPortal],
]);
