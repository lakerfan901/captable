/**
 * Financial snapshots, the P38 release check and Restate
 * (04-investor-portal.md P33–P35, P38, 5.9; package P13a) against the local
 * database. Not part of `vitest run`. Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx --env-file=.env \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/portal/__integration__/financial-snapshots.integration.ts
 *
 * Companies are named `zz-fin-snap-…`, addresses are `@example.com`. Every
 * release is portal-only (no email); pg-boss is not started (the filing job
 * is captured). Every row created is deleted at the end.
 *
 * Fixture. Company 1 (2026): A and B (Preferred Members, receipts in January
 * and February), M (Common Member, insider), X (a prospect without
 * anything). Revenue January–September, expenses (one from capital), a
 * minimum reserve, a Management Fee payment and an OPERATING distribution
 * paid in April. Company 2: one Preferred Member with revenue January–
 * September.
 * Economics "today" is pinned to 2026-10-05; release checks its period
 * against the real date, so the periods used (Q1–Q3 2026) have ended.
 *
 * Oracle. A stored month is compared with the existing services, not with
 * the series builder: every fund record with `getPeriodEconomics` and
 * `getPositions` for that month, every holder record (and every month a
 * holder has NO record) with `getMemberStatement` for that month.
 */

import { isDeepStrictEqual } from "node:util";
import { reportFileJob } from "@/jobs/governance-report-file";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { ReconciliationRefusal } from "@/lib/governance/reconcile-refusal";
import { monthEnd, monthsBetween } from "@/lib/llc/financial-periods";
import type { FundMonth, HolderMonth } from "@/lib/llc/financial-series";
import {
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
  race,
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
import { getMemberStatement, getPeriodEconomics } from "@/server/llc/economics";
import {
  computeDistribution,
  finalizeDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { getPositions } from "@/server/llc/economics/ledger";
import {
  type RestateActor,
  restateSnapshots,
} from "@/server/portal/financial-snapshot-write";
import {
  latestSnapshotMonth,
  publishedThroughFor,
  readFundMonths,
  readHolderMonths,
  readRestatements,
} from "@/server/portal/financial-snapshots";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberReportRouter } from "@/trpc/routers/member-report-router/router";

setCompanyPrefix("zz-fin-snap-");

const show = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

/** Deep equality (arrays, objects, bigints) with both values in the failure detail. */
function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    isDeepStrictEqual(actual, expected),
    `got ${show(actual)}, expected ${show(expected)}`,
  );
}

/** The error a call throws (the object itself, cause included), or null. */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}
const TODAY = "2026-10-05";

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
      updatedById: "fin-snap-integration",
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
      createdById: "fin-snap-integration",
    },
  });
}

/** Company 1: the 2026 history described at the top. */
async function company1() {
  const c = await createCompany("one");
  const A = await newMember(c, "A Preferred");
  const B = await newMember(c, "B Preferred");
  const M = await newMember(c, "M Common", { isInsider: true });
  const X = await newMember(c, "X Prospect");
  await issueCommon(c, M.id, "100", "2026-01-05");
  await subscribeOn(c, A.id, usd(100_000), "2026-01-12");
  await subscribeOn(c, B.id, usd(250_000), "2026-02-10");
  const receipts = [
    usd(18_000),
    usd(21_500),
    usd(24_000),
    usd(26_250),
    usd(0),
    usd(30_000),
    usd(31_000),
    usd(29_500),
    usd(33_000),
  ];
  const months = monthsBetween("2026-01-01", "2026-09-01");
  for (const [i, m] of months.entries()) {
    await revenue(c, m, receipts[i] ?? 0n, i % 3 === 1 ? null : 8_000 + i);
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
  await expense(c, "2026-08-11", "COLOCATION", usd(3_100));
  await db.reserveEntry.create({
    data: {
      companyId: c.id,
      effectiveOn: fromDateOnly("2026-01-15"),
      kind: "MINIMUM_OPERATING",
      type: "ESTABLISH",
      amountCents: usd(50_000),
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      reason: "Minimum operating reserve (integration)",
      createdById: "fin-snap-integration",
    },
  });
  await db.managerPayment.create({
    data: {
      companyId: c.id,
      paidOn: fromDateOnly("2026-04-06"),
      payee: "Manager LLC",
      amountCents: usd(1_500),
      category: "MANAGEMENT_FEE",
      createdById: "fin-snap-integration",
    },
  });
  // An OPERATING distribution for Q1, paid in April.
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
  const admin = await createAdmin(c);
  const reports = createCallerFactory(memberReportRouter)(admin.context);
  const memberId = (admin.session.user as unknown as { memberId: string })
    .memberId;
  const restateActor: RestateActor = {
    userId: admin.session.user.id,
    userName: "Integration",
    memberId,
    requestIp: "127.0.0.1",
    userAgent: "fin-snap-integration",
  };
  return { c, A, B, M, X, admin, reports, memberId, restateActor };
}

/** Company 2: one Preferred Member, revenue January–September 2026. */
async function company2() {
  const c = await createCompany("two");
  const P = await newMember(c, "P Preferred");
  await subscribeOn(c, P.id, usd(80_000), "2026-01-20");
  for (const m of monthsBetween("2026-01-01", "2026-09-01")) {
    await revenue(c, m, usd(5_000), 7_500);
  }
  setToday(TODAY);
  const admin = await createAdmin(c);
  const reports = createCallerFactory(memberReportRouter)(admin.context);
  const memberId = (admin.session.user as unknown as { memberId: string })
    .memberId;
  const restateActor: RestateActor = {
    userId: admin.session.user.id,
    userName: "Integration",
    memberId,
    requestIp: "127.0.0.1",
    userAgent: "fin-snap-integration",
  };
  return { c, P, reports, restateActor };
}

type Reports = Awaited<ReturnType<typeof company1>>["reports"];

/** A complete quarterly draft: prefilled from the ledger, utilization typed. */
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
  const figures = JSON.parse(JSON.stringify(row.figures)) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture edits JSON
    any
  >;
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

/** Hand-edits a draft's figures (title and commentary as `quarterDraft` set them). */
async function editFigures(
  reports: Reports,
  publicId: string,
  figures: unknown,
) {
  const row = await db.memberReport.findFirstOrThrow({ where: { publicId } });
  await reports.update({
    publicId,
    title: row.title,
    figures,
    commentary: row.commentary,
  });
}

const release = (reports: Reports, publicId: string, ids: string[]) =>
  reports.release({ publicId, stakeholderIds: ids, email: false });

// ---------------------------------------------------------------------------
// Oracle

/** Every stored figure of a fund month that the services give for that month. */
async function fundAgainstServices(
  c: TestCompany,
  m: FundMonth,
): Promise<string[]> {
  const end = monthEnd(m.month);
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
    ["inProgress", m.inProgress, false],
    ["grossRevenue", m.grossRevenue, pe.revenue.grossRevenue],
    ["otherIncome", m.otherIncome, pe.revenue.otherIncome],
    ["assetSaleProceeds", m.assetSaleProceeds, pe.revenue.assetSaleProceeds],
    ["insuranceProceeds", m.insuranceProceeds, pe.revenue.insuranceProceeds],
    ["totalExpenses", m.totalExpenses, pe.expenses.total],
    ["operatingExpenses", m.operatingExpenses, pe.expenses.operating],
    ["capitalFundedExpenses", m.capitalFundedExpenses, pe.expenses.fromCapital],
    [
      "expensesByCategory",
      JSON.stringify(
        m.expensesByCategory.map((x) => [x.category, String(x.amount)]),
      ),
      JSON.stringify(
        [...pe.expenses.byCategory]
          .sort((a, b) => (a.category < b.category ? -1 : 1))
          .map((x) => [x.category, String(x.amount)]),
      ),
    ],
    ["managementFeeAccrued", m.managementFeeAccrued, pe.managementFee.accrued],
    ["managementFeePaid", m.managementFeePaid, pe.managementFee.paid],
    [
      "managementFeeUnpaid",
      m.managementFeeUnpaid,
      pe.managementFee.unpaidAtEnd,
    ],
    ["reserveBalance", m.reserveBalance, pe.reserves.balanceAtEnd],
    ["minimumReserve", m.minimumReserve, pe.reserves.minimumRequired],
    ["reservesEstablished", m.reservesEstablished, pe.reserves.established],
    ["reservesReleased", m.reservesReleased, pe.reserves.released],
    ["availableCash", m.availableCash, pe.availableCashAtEnd.availableCash],
    ["distributions.gross", m.distributions.gross, pe.distributions.totalGross],
    ["distributions.preferredReturn", m.distributions.preferredReturn, tiers.c],
    ["distributions.returnOfCapital", m.distributions.returnOfCapital, tiers.d],
    [
      "distributions.residualPreferred",
      m.distributions.residualPreferred,
      tiers.ep,
    ],
    ["distributions.residualCommon", m.distributions.residualCommon, tiers.ec],
    ["paidInCapital", m.paidInCapital, pos.totals.contributed],
    ["unreturnedCapital", m.unreturnedCapital, pos.totals.unreturned],
    ["preferredReturnUnpaid", m.preferredReturnUnpaid, pos.totals.unpaidReturn],
    [
      "memberLoansOutstanding",
      m.memberLoansOutstanding,
      pe.memberLoansOutstandingAtEnd,
    ],
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

const HOLDER_ZERO_KEYS = [
  "contributions",
  "credits",
  "forfeited",
  "preferredReturnAccrued",
  "preferredReturnPaid",
  "capitalReturned",
  "residualPaid",
  "grossDistributions",
  "defaultOffsets",
  "taxAdvanceOffsets",
  "netPaid",
  "paidIn",
  "unreturnedCapital",
  "preferredUnits",
  "commonUnits",
  "preferredReturnUnpaid",
  "committed",
  "uncalled",
  "calledOutstanding",
] as const;

/** A holder month (or its absence) against `getMemberStatement` for that month. */
async function holderAgainstStatement(
  c: TestCompany,
  stakeholderId: string,
  month: string,
  h: HolderMonth | undefined,
): Promise<string[]> {
  const st = await getMemberStatement(db, c.id, stakeholderId, {
    from: month,
    to: monthEnd(month),
  });
  const want: Record<(typeof HOLDER_ZERO_KEYS)[number], bigint> = {
    contributions: st.period.contributions,
    credits: st.period.credits,
    forfeited: st.period.forfeited,
    preferredReturnAccrued: st.period.returnAccrued,
    preferredReturnPaid: st.period.returnPaid,
    capitalReturned: st.period.capitalReturned,
    residualPaid: st.period.residualPaid,
    grossDistributions: st.period.grossDistributions,
    defaultOffsets: st.period.defaultOffsets,
    taxAdvanceOffsets: st.period.taxAdvanceOffsets,
    netPaid: st.period.netPaid,
    paidIn: st.closing.contributed,
    unreturnedCapital: st.closing.unreturned,
    preferredUnits: st.closing.preferredUnits,
    commonUnits: st.closing.commonUnits,
    preferredReturnUnpaid: st.closing.unpaidReturn,
    committed: st.commitment?.committed ?? 0n,
    uncalled: st.commitment?.uncalled ?? 0n,
    calledOutstanding: st.commitment?.calledOutstanding ?? 0n,
  };
  const out: string[] = [];
  for (const k of HOLDER_ZERO_KEYS) {
    const got = h ? h[k] : 0n;
    if (got !== want[k]) out.push(`${k}: ${String(got)} ≠ ${String(want[k])}`);
  }
  if (h && h.preferredPct !== st.closing.preferredPct) {
    out.push(`preferredPct: ${h.preferredPct} ≠ ${st.closing.preferredPct}`);
  }
  return out;
}

/** Every current row of `months` against the services, every stakeholder of the company. */
async function oracle(label: string, c: TestCompany, months: string[]) {
  const fundRows = await db.financialSnapshot.findMany({
    where: { companyId: c.id, supersededAt: null },
  });
  const holderRows = await db.holderFinancialSnapshot.findMany({
    where: { companyId: c.id, supersededAt: null },
  });
  const stakeholders = await db.stakeholder.findMany({
    where: { companyId: c.id },
    select: { id: true, name: true },
  });
  for (const month of months) {
    const row = fundRows.find((r) => toDateOnly(r.month) === month);
    if (!row) {
      check(`${label}: fund ${month} exists`, false);
      continue;
    }
    const diffs = await fundAgainstServices(c, fundMonthFromJson(row.data));
    check(
      `${label}: fund ${month.slice(0, 7)} = getPeriodEconomics + getPositions`,
      diffs.length === 0,
      diffs.join("; "),
    );
    for (const s of stakeholders) {
      const hr = holderRows.find(
        (r) => r.stakeholderId === s.id && toDateOnly(r.month) === month,
      );
      const h = hr ? holderMonthFromJson(hr.data) : undefined;
      const hd = await holderAgainstStatement(c, s.id, month, h);
      check(
        `${label}: ${s.name} ${month.slice(0, 7)} ${hr ? "row" : "no row"} = getMemberStatement`,
        hd.length === 0,
        hd.join("; "),
      );
    }
  }
}

async function currentCounts(companyId: string) {
  return {
    fund: await db.financialSnapshot.count({
      where: { companyId, supersededAt: null },
    }),
    fundAll: await db.financialSnapshot.count({ where: { companyId } }),
    holder: await db.holderFinancialSnapshot.count({
      where: { companyId, supersededAt: null },
    }),
    holderAll: await db.holderFinancialSnapshot.count({ where: { companyId } }),
  };
}

/** One current fund row per month, at most one current holder row per holder and month, same version. */
async function invariants(label: string, companyId: string) {
  const dupFund = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT "month" FROM "FinancialSnapshot"
      WHERE "companyId" = ${companyId} AND "supersededAt" IS NULL
      GROUP BY "month" HAVING count(*) > 1) d`;
  const dupHolder = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT "stakeholderId", "month" FROM "HolderFinancialSnapshot"
      WHERE "companyId" = ${companyId} AND "supersededAt" IS NULL
      GROUP BY "stakeholderId", "month" HAVING count(*) > 1) d`;
  const mismatched = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "HolderFinancialSnapshot" h
    JOIN "FinancialSnapshot" f
      ON f."companyId" = h."companyId" AND f."month" = h."month"
     AND f."supersededAt" IS NULL
    WHERE h."companyId" = ${companyId} AND h."supersededAt" IS NULL
      AND h."version" <> f."version"`;
  const orphan = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "HolderFinancialSnapshot" h
    WHERE h."companyId" = ${companyId} AND h."supersededAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "FinancialSnapshot" f
        WHERE f."companyId" = h."companyId" AND f."month" = h."month"
          AND f."supersededAt" IS NULL)`;
  eq(`${label}: no month with two current fund rows`, Number(dupFund[0]?.n), 0);
  eq(
    `${label}: no holder-month with two current rows`,
    Number(dupHolder[0]?.n),
    0,
  );
  eq(
    `${label}: current holder rows carry their month's fund version`,
    Number(mismatched[0]?.n),
    0,
  );
  eq(
    `${label}: no current holder row without a current fund row`,
    Number(orphan[0]?.n),
    0,
  );
}

const Q1 = ["2026-01-01", "2026-02-01", "2026-03-01"];
const Q2Q3 = monthsBetween("2026-04-01", "2026-09-01");

// ---------------------------------------------------------------------------
// Scenarios

let w1: Awaited<ReturnType<typeof company1>>;
let w2: Awaited<ReturnType<typeof company2>>;
const pub: { q1?: string; q2?: string; q3?: string } = {};

async function releaseQ1() {
  section("T-FIN-1: releasing Q1 writes January–March from inception");
  w1 = await company1();
  const { c, A, B, M, X, reports } = w1;
  eq("no snapshot before any release", (await currentCounts(c.id)).fundAll, 0);
  pub.q1 = await quarterDraft(reports, c.id, 1);
  const rec = await reports.reconcile({ publicId: pub.q1 });
  check(
    "reconcile: a refreshed draft matches the ledger",
    rec.checked && rec.source === "DRAFT" && rec.differences.length === 0,
    JSON.stringify(rec.differences),
  );
  const out = await release(reports, pub.q1, [A.id, B.id]);
  eq("result names January–March", out.snapshotMonths, Q1);
  const report = await db.memberReport.findFirstOrThrow({
    where: { publicId: pub.q1, companyId: c.id },
  });
  const fund = await db.financialSnapshot.findMany({
    where: { companyId: c.id },
    orderBy: { month: "asc" },
  });
  eq(
    "three fund rows, January–March",
    fund.map((r) => toDateOnly(r.month)),
    Q1,
  );
  check(
    "fund rows: version 1, current, from this report, frozen by the admin",
    fund.every(
      (r) =>
        r.version === 1 &&
        r.supersededAt === null &&
        r.sourceReportId === report.id &&
        r.restateReason === null &&
        r.frozenById === w1.memberId,
    ),
  );
  const holders = await db.holderFinancialSnapshot.findMany({
    where: { companyId: c.id },
  });
  const rowsOf = (id: string) =>
    holders
      .filter((h) => h.stakeholderId === id)
      .map((h) => toDateOnly(h.month))
      .sort();
  eq("A has rows January–March (receipt 2026-01-12)", rowsOf(A.id), Q1);
  eq(
    "B has rows February–March (receipt 2026-02-10)",
    rowsOf(B.id),
    Q1.slice(1),
  );
  eq(
    "M (Common only, not in the audience) has rows January–March",
    rowsOf(M.id),
    Q1,
  );
  eq("X (prospect, nothing) has no row", rowsOf(X.id), []);
  check(
    "every holder row: version 1, current, its holder id in the data",
    holders.every(
      (h) =>
        h.version === 1 &&
        h.supersededAt === null &&
        holderMonthFromJson(h.data).holderId === h.stakeholderId,
    ),
  );
  eq(
    "the books are closed through 2026-03-31",
    toDateOnly(
      (await db.llcTerm.findFirstOrThrow({ where: { companyId: c.id } }))
        .booksClosedThrough as Date,
    ),
    "2026-03-31",
  );
  await oracle("Q1 snapshot", c, Q1);
  await invariants("after Q1", c.id);
}

async function reconciliationGate() {
  section("T-FIN-2: P38 refuses a hand-edited figure and names it");
  const { c, A, B, reports } = w1;
  pub.q3 = await quarterDraft(reports, c.id, 3);
  const row = await db.memberReport.findFirstOrThrow({
    where: { publicId: pub.q3, companyId: c.id },
  });
  const figures = JSON.parse(JSON.stringify(row.figures)) as {
    revenue: { amountCents: number };
    expenses: { lines: { category: string; amountCents: number }[] };
  };
  const ledgerRevenue = figures.revenue.amountCents;
  figures.revenue.amountCents = ledgerRevenue + 1;
  await editFigures(reports, pub.q3, figures);
  const rec = await reports.reconcile({ publicId: pub.q3 });
  eq(
    "reconcile lists exactly the revenue figure, one cent apart",
    rec.differences,
    [
      {
        field: "revenue.amountCents",
        reportCents: ledgerRevenue + 1,
        ledgerCents: ledgerRevenue,
      },
    ],
  );
  const before = await currentCounts(c.id);
  const err = (await thrown(() =>
    release(reports, pub.q3 as string, [B.id]),
  )) as { code?: string; message?: string; cause?: unknown } | null;
  const code = err?.code;
  eq("release refused with PRECONDITION_FAILED", code, "PRECONDITION_FAILED");
  const cause = err?.cause;
  check(
    "the cause is a ReconciliationRefusal with the same difference",
    cause instanceof ReconciliationRefusal &&
      cause.differences.length === 1 &&
      cause.differences[0]?.field === "revenue.amountCents",
  );
  check(
    "the message names the figure and both amounts",
    /Gross Revenue \(report \$[\d,]+\.\d\d, ledger \$[\d,]+\.\d\d\)/.test(
      err?.message ?? "",
    ),
    err?.message,
  );
  // The client sees the list through the error formatter.
  const formatter = (
    memberReportRouter as unknown as {
      _def: {
        _config: {
          errorFormatter: (o: {
            shape: { data: Record<string, unknown> };
            error: unknown;
          }) => { data: { reconciliation: unknown } };
        };
      };
    }
  )._def._config.errorFormatter;
  const shaped = formatter({
    shape: { data: { code: "PRECONDITION_FAILED" } },
    error: err,
  });
  eq(
    "error.data.reconciliation carries the differences",
    shaped.data.reconciliation,
    {
      differences: rec.differences,
    },
  );
  eq(
    "another error has reconciliation null",
    formatter({ shape: { data: {} }, error: new Error("x") }).data
      .reconciliation,
    null,
  );
  const after = await db.memberReport.findFirstOrThrow({
    where: { publicId: pub.q3, companyId: c.id },
  });
  check(
    "nothing written: still a draft, no recipient, not published, no snapshot",
    after.status === "DRAFT" &&
      after.publishedAt === null &&
      (await db.memberReportRecipient.count({
        where: { reportId: after.id },
      })) === 0 &&
      JSON.stringify(await currentCounts(c.id)) === JSON.stringify(before),
  );
  eq(
    "the books stay closed through 2026-03-31",
    toDateOnly(
      (await db.llcTerm.findFirstOrThrow({ where: { companyId: c.id } }))
        .booksClosedThrough as Date,
    ),
    "2026-03-31",
  );
  // An expense line edited the same way is named by its category.
  await reports.refreshFigures({ publicId: pub.q3 });
  const fresh = await db.memberReport.findFirstOrThrow({
    where: { publicId: pub.q3, companyId: c.id },
  });
  const f2 = JSON.parse(JSON.stringify(fresh.figures)) as typeof figures;
  const line = f2.expenses.lines[0];
  if (line) line.amountCents += 100;
  await editFigures(reports, pub.q3, f2);
  const rec2 = await reports.reconcile({ publicId: pub.q3 });
  check(
    "reconcile names an edited expense line by category",
    rec2.differences.some(
      (d) => d.field === `expenses.lines[${line?.category}]`,
    ),
    JSON.stringify(rec2.differences),
  );

  section("T-FIN-2b: after Refresh from ledger, Q3 releases and fills Q2");
  await reports.refreshFigures({ publicId: pub.q3 });
  eq(
    "reconcile is empty after the refresh",
    (await reports.reconcile({ publicId: pub.q3 })).differences,
    [],
  );
  const out = await release(reports, pub.q3, [B.id]);
  eq(
    "Q3 without Q2 writes six months (April–September)",
    out.snapshotMonths,
    Q2Q3,
  );
  eq("nine current fund rows", (await currentCounts(c.id)).fund, 9);
  const april = (await readFundMonths(db, c.id, { through: "2026-04-30" })).at(
    -1,
  );
  const aApril = (
    await readHolderMonths(
      db,
      { companyId: c.id, stakeholderId: A.id },
      { through: "2026-04-30" },
    )
  ).at(-1);
  check(
    "the oracle is not vacuous: April carries the distribution, A's share, revenue and capital",
    april !== undefined &&
      april.month === "2026-04-01" &&
      april.distributions.gross > 0n &&
      april.grossRevenue > 0n &&
      april.paidInCapital === usd(350_000) &&
      aApril !== undefined &&
      aApril.month === "2026-04-01" &&
      aApril.grossDistributions > 0n,
  );
  await oracle("Q2–Q3 snapshot", c, Q2Q3);
  await invariants("after Q3", c.id);
}

async function coveredPeriod() {
  section("T-FIN-3: a period already covered writes nothing");
  const { c, B, reports } = w1;
  const before = await currentCounts(c.id);
  pub.q2 = await quarterDraft(reports, c.id, 2);
  const out = await release(reports, pub.q2, [B.id]);
  eq("Q2 after Q3: no month written", out.snapshotMonths, []);
  eq("no row added", await currentCounts(c.id), before);
  const notice = await reports.create({
    type: "NOTICE",
    noticeKind: "GENERAL",
  });
  const r = await reports.reconcile({ publicId: notice.publicId });
  check(
    "reconcile on a notice: not checked (NO_FIGURES)",
    !r.checked && r.reason === "NO_FIGURES" && r.differences.length === 0,
  );
  const q1Row = await db.memberReport.findFirstOrThrow({
    where: { publicId: pub.q1 as string },
  });
  await reports.update({
    publicId: notice.publicId,
    title: "A notice",
    figures: {},
    commentary: q1Row.commentary,
  });
  const noticeOut = await release(reports, notice.publicId, [B.id]);
  eq("releasing a notice writes no snapshot", noticeOut.snapshotMonths, []);
  eq("still no row added", await currentCounts(c.id), before);
}

async function publishedThrough() {
  section(
    "T-FIN-4: published-through per holder (P33) and reads by holder (P36)",
  );
  const { c, A, B, M, reports } = w1;
  const a = { companyId: c.id, stakeholderId: A.id };
  const b = { companyId: c.id, stakeholderId: B.id };
  const m = { companyId: c.id, stakeholderId: M.id };
  eq(
    "A (Q1 only) is published through 2026-03-31",
    await publishedThroughFor(db, a),
    "2026-03-31",
  );
  eq(
    "B (Q1, Q2, Q3) is published through 2026-09-30",
    await publishedThroughFor(db, b),
    "2026-09-30",
  );
  eq("M (in no report) has no date", await publishedThroughFor(db, m), null);
  const aThrough = await publishedThroughFor(db, a);
  const aFund = await readFundMonths(db, c.id, { through: aThrough });
  eq(
    "A reads fund months January–March although April–September exist",
    aFund.map((x) => x.month),
    Q1,
  );
  const aMine = await readHolderMonths(db, a, { through: aThrough });
  check(
    "A reads only its own holder months (by id), January–March",
    aMine.length === 3 && aMine.every((h) => h.holderId === A.id),
    JSON.stringify(aMine.map((h) => [h.holderId, h.month])),
  );
  const bMine = await readHolderMonths(db, b, {
    through: await publishedThroughFor(db, b),
  });
  check(
    "B reads only its own holder months, February–September",
    bMine.length === 8 && bMine.every((h) => h.holderId === B.id),
  );
  eq("M reads nothing", await readFundMonths(db, c.id, { through: null }), []);
  eq(
    "a mid-month date publishes only whole months",
    (await readFundMonths(db, c.id, { through: "2026-05-30" })).map(
      (x) => x.month,
    ),
    monthsBetween("2026-01-01", "2026-04-01"),
  );
  await reports.unpublish({ publicId: pub.q1 as string });
  eq(
    "after unpublishing Q1, A has no date",
    await publishedThroughFor(db, a),
    null,
  );
  eq(
    "and reads no fund month",
    await readFundMonths(db, c.id, {
      through: await publishedThroughFor(db, a),
    }),
    [],
  );
  eq("B keeps 2026-09-30", await publishedThroughFor(db, b), "2026-09-30");
  await reports.publish({ publicId: pub.q1 as string });
  eq(
    "publishing Q1 again restores A's date",
    await publishedThroughFor(db, a),
    "2026-03-31",
  );
}

async function frozenThenRestate() {
  section("T-FIN-5: snapshots are frozen; the ledger may move");
  const { c, A, reports, restateActor } = w1;
  const snapshotOf = async () =>
    (
      await db.financialSnapshot.findMany({
        where: { companyId: c.id },
        orderBy: [{ month: "asc" }, { version: "asc" }],
        select: { id: true, dataHash: true, supersededAt: true },
      })
    ).map((r) => `${r.id}:${r.dataHash}:${r.supersededAt === null}`);
  const holderOf = async () =>
    (
      await db.holderFinancialSnapshot.findMany({
        where: { companyId: c.id },
        orderBy: { id: "asc" },
        select: { id: true, data: true, supersededAt: true },
      })
    ).map(
      (r) => `${r.id}:${JSON.stringify(r.data)}:${r.supersededAt === null}`,
    );
  const fundBefore = await snapshotOf();
  const holderBefore = await holderOf();
  const febBefore = (
    await readFundMonths(db, c.id, { through: "2026-02-28" })
  ).at(-1) as FundMonth;
  // Reopen the books, then a back-dated February expense.
  await db.llcTerm.update({
    where: { companyId: c.id },
    data: { booksClosedThrough: null },
  });
  await expense(c, "2026-02-20", "POWER", usd(777));
  const pe = await getPeriodEconomics(db, c.id, {
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
  });
  eq(
    "the ledger now has $777.00 more February expenses",
    pe.expenses.total - febBefore.totalExpenses,
    usd(777),
  );
  eq(
    "fund rows unchanged (ids, hashes, current)",
    await snapshotOf(),
    fundBefore,
  );
  eq("holder rows unchanged", await holderOf(), holderBefore);
  const febAfter = (
    await readFundMonths(db, c.id, { through: "2026-02-28" })
  ).at(-1) as FundMonth;
  eq(
    "the published February still shows the old expenses",
    febAfter.totalExpenses,
    febBefore.totalExpenses,
  );
  const drift = await reports.reconcile({ publicId: pub.q1 as string });
  check(
    "reconcile on the released Q1 (frozen figures) reports the drift",
    drift.source === "FROZEN" &&
      drift.differences.some((d) => d.field === "expenses.totalCents"),
    JSON.stringify(drift.differences),
  );

  section(
    "T-FIN-6: Restate replaces under lock, keeps the old rows, is audited",
  );
  const tooShort = await errorOf(() =>
    inTx((tx) =>
      restateSnapshots(tx, {
        companyId: c.id,
        fromMonth: "2026-02-01",
        toMonth: "2026-02-01",
        reason: "short",
        actor: restateActor,
      }),
    ),
  );
  check(
    "a reason under 10 characters is refused",
    /10 to 500/.test(tooShort?.message ?? ""),
    tooShort?.message,
  );
  const late = await errorOf(() =>
    inTx((tx) =>
      restateSnapshots(tx, {
        companyId: c.id,
        fromMonth: "2026-09-01",
        toMonth: "2026-10-01",
        reason: "Back-dated power invoice",
        actor: restateActor,
      }),
    ),
  );
  check(
    "a month after the latest snapshot is refused",
    /latest is 2026-09/.test(late?.message ?? ""),
    late?.message,
  );
  const countsBeforeEarly = await currentCounts(c.id);
  const early = await errorOf(() =>
    inTx((tx) =>
      restateSnapshots(tx, {
        companyId: c.id,
        fromMonth: "2018-01-01",
        toMonth: "2026-01-01",
        reason: "Restate from long before inception",
        actor: restateActor,
      }),
    ),
  );
  check(
    "a range before inception is refused",
    /no figures before 2026-01/.test(early?.message ?? ""),
    early?.message,
  );
  eq(
    "and writes nothing (no empty month rows)",
    await currentCounts(c.id),
    countsBeforeEarly,
  );
  const reason = "Back-dated power invoice for February";
  const result = await inTx((tx) =>
    restateSnapshots(tx, {
      companyId: c.id,
      fromMonth: "2026-01-01",
      toMonth: "2026-03-01",
      reason,
      actor: restateActor,
    }),
  );
  // March: its end-of-month figures do not move (Available Cash is
  // distributed to zero at 2026-03-31 either way); the oracle below proves
  // every left-alone month still equals the ledger.
  check(
    "January (before the expense) is unchanged and left alone; February is not",
    result.unchanged.includes("2026-01-01") &&
      !result.unchanged.includes("2026-02-01"),
    JSON.stringify(result.unchanged),
  );
  for (const m of result.unchanged) {
    eq(
      `left-alone ${m.slice(0, 7)} keeps its single version-1 row`,
      (
        await db.financialSnapshot.findMany({
          where: { companyId: c.id, month: fromDateOnly(m) },
        })
      ).map((r) => `${r.version}:${r.supersededAt === null}`),
      ["1:true"],
    );
  }
  const feb = result.months.find((m) => m.month === "2026-02-01");
  check(
    "February restated to version 2, naming the expense fields",
    feb !== undefined &&
      feb.version === 2 &&
      feb.fundFields.includes("totalExpenses") &&
      feb.fundFields.includes("operatingExpenses"),
    JSON.stringify(result.months),
  );
  const febRows = await db.financialSnapshot.findMany({
    where: { companyId: c.id, month: fromDateOnly("2026-02-01") },
    orderBy: { version: "asc" },
  });
  check(
    "February: v1 kept and superseded, v2 current with the reason and no report",
    febRows.length === 2 &&
      febRows[0]?.supersededAt !== null &&
      febRows[1]?.supersededAt === null &&
      febRows[1]?.version === 2 &&
      febRows[1]?.restateReason === reason &&
      febRows[1]?.sourceReportId === null &&
      febRows[1]?.frozenById === w1.memberId,
  );
  const janRows = await db.financialSnapshot.count({
    where: { companyId: c.id, month: fromDateOnly("2026-01-01") },
  });
  eq("January still has one row", janRows, 1);
  const febHolders = await db.holderFinancialSnapshot.findMany({
    where: { companyId: c.id, month: fromDateOnly("2026-02-01") },
  });
  check(
    "February holder rows: every v1 superseded, every current row v2",
    febHolders.every((h) =>
      h.version === 1 ? h.supersededAt !== null : h.supersededAt === null,
    ) && febHolders.some((h) => h.version === 2),
  );
  const febNow = (await readFundMonths(db, c.id, { through: "2026-02-28" })).at(
    -1,
  ) as FundMonth;
  eq(
    "the published February now shows the new expenses",
    febNow.totalExpenses - febBefore.totalExpenses,
    usd(777),
  );
  const restatements = await readRestatements(db, c.id, {
    through: "2026-09-30",
  });
  check(
    "readRestatements lists February (and the other restated months)",
    restatements.some((r) => r.month === "2026-02-01" && r.version === 2) &&
      restatements.every((r) => r.month !== "2026-01-01"),
    JSON.stringify(restatements),
  );
  eq(
    "A (published through March) sees the February restatement",
    (
      await readRestatements(db, c.id, {
        through: await publishedThroughFor(db, {
          companyId: c.id,
          stakeholderId: A.id,
        }),
      })
    ).some((r) => r.month === "2026-02-01"),
    true,
  );
  const audit = await db.audit.findMany({
    where: { companyId: c.id, action: "financials.restated" },
  });
  check(
    "one audit row financials.restated naming February and the reason",
    audit.length === 1 &&
      /Feb 2026/.test(audit[0]?.summary ?? "") &&
      (audit[0]?.summary ?? "").includes(reason),
    audit[0]?.summary ?? "none",
  );
  await oracle("after Restate", c, Q1);
  await invariants("after Restate", c.id);
  const again = await errorOf(() =>
    inTx((tx) =>
      restateSnapshots(tx, {
        companyId: c.id,
        fromMonth: "2026-01-01",
        toMonth: "2026-03-01",
        reason,
        actor: restateActor,
      }),
    ),
  );
  check(
    "restating again with nothing changed is refused",
    /Nothing to restate/.test(again?.message ?? ""),
    again?.message,
  );
  eq(
    "and writes no second audit row",
    await db.audit.count({
      where: { companyId: c.id, action: "financials.restated" },
    }),
    1,
  );
}

async function concurrency() {
  section("T-FIN-7: concurrent restatements produce one consistent set");
  const { c, restateActor } = w1;
  await expense(c, "2026-05-12", "COLOCATION", usd(50));
  const restate = (tx: Parameters<Parameters<typeof inTx>[0]>[0]) =>
    restateSnapshots(tx, {
      companyId: c.id,
      fromMonth: "2026-05-01",
      toMonth: "2026-05-01",
      reason: "Back-dated colocation charge for May",
      actor: restateActor,
    });
  const r = await race(restate, restate);
  check("restate race: separate connections", r.pids[0] !== r.pids[1]);
  check("restate race: the second waited for the ledger lock", r.secondWaited);
  check("restate race: the first restated", r.first.ok);
  check(
    "restate race: the second then found nothing to restate",
    !r.second.ok && /Nothing to restate/.test(r.second.message),
    r.second.ok ? "succeeded" : r.second.message,
  );
  eq(
    "May has exactly two fund rows (v1 superseded, v2 current)",
    (
      await db.financialSnapshot.findMany({
        where: { companyId: c.id, month: fromDateOnly("2026-05-01") },
        orderBy: { version: "asc" },
      })
    ).map((x) => `${x.version}:${x.supersededAt === null}`),
    ["1:false", "2:true"],
  );
  await invariants("after the restate race", c.id);

  section("T-FIN-7b: concurrent releases of one company produce one set");
  w2 = await company2();
  const q1 = await quarterDraft(w2.reports, w2.c.id, 1);
  const q2 = await quarterDraft(w2.reports, w2.c.id, 2);
  const [a, b] = await Promise.allSettled([
    release(w2.reports, q1, [w2.P.id]),
    release(w2.reports, q2, [w2.P.id]),
  ]);
  check(
    "both releases succeed",
    a.status === "fulfilled" && b.status === "fulfilled",
    [a, b]
      .map((x) => (x.status === "rejected" ? String(x.reason) : "ok"))
      .join(" | "),
  );
  const written = [a, b].flatMap((x) =>
    x.status === "fulfilled" ? x.value.snapshotMonths : [],
  );
  eq(
    "between them they wrote January–June once",
    [...written].sort(),
    monthsBetween("2026-01-01", "2026-06-01"),
  );
  eq(
    "six fund rows, all version 1",
    (
      await db.financialSnapshot.findMany({
        where: { companyId: w2.c.id },
        orderBy: { month: "asc" },
      })
    ).map((x) => `${toDateOnly(x.month)}:${x.version}`),
    monthsBetween("2026-01-01", "2026-06-01").map((m) => `${m}:1`),
  );
  await invariants("company 2 after concurrent releases", w2.c.id);
  await oracle("company 2", w2.c, monthsBetween("2026-01-01", "2026-06-01"));

  section("T-FIN-7c: a release and a restatement of one company in parallel");
  await db.llcTerm.update({
    where: { companyId: w2.c.id },
    data: { booksClosedThrough: null },
  });
  await expense(w2.c, "2026-03-09", "POWER", usd(10));
  const q3 = await quarterDraft(w2.reports, w2.c.id, 3);
  const [rel, res] = await Promise.allSettled([
    release(w2.reports, q3, [w2.P.id]),
    inTx((tx) =>
      restateSnapshots(tx, {
        companyId: w2.c.id,
        fromMonth: "2026-03-01",
        toMonth: "2026-03-01",
        reason: "Back-dated power for March",
        actor: w2.restateActor,
      }),
    ),
  ]);
  check(
    "both succeed (serialised by the ledger lock)",
    rel.status === "fulfilled" && res.status === "fulfilled",
    [rel, res]
      .map((x) => (x.status === "rejected" ? String(x.reason) : "ok"))
      .join(" | "),
  );
  eq(
    "July–September written by the release",
    rel.status === "fulfilled" ? rel.value.snapshotMonths : null,
    monthsBetween("2026-07-01", "2026-09-01"),
  );
  await invariants("company 2 after release + restate", w2.c.id);
  eq(
    "latest snapshot month of company 2 is September",
    await latestSnapshotMonth(db, w2.c.id),
    "2026-09-01",
  );
}

async function isolation() {
  section("T-FIN-8: cross-company isolation");
  const { c, A, reports } = w1;
  const c1Fund = (
    await db.financialSnapshot.findMany({
      where: { companyId: c.id },
      select: { id: true, supersededAt: true },
      orderBy: { id: "asc" },
    })
  ).map((r) => `${r.id}:${r.supersededAt === null}`);
  await db.llcTerm.update({
    where: { companyId: w2.c.id },
    data: { booksClosedThrough: null },
  });
  await expense(w2.c, "2026-02-03", "POWER", usd(5));
  await inTx((tx) =>
    restateSnapshots(tx, {
      companyId: w2.c.id,
      fromMonth: "2026-02-01",
      toMonth: "2026-02-01",
      reason: "Company two correction only",
      actor: w2.restateActor,
    }),
  );
  eq(
    "a restatement of company 2 leaves company 1's rows as they were",
    (
      await db.financialSnapshot.findMany({
        where: { companyId: c.id },
        select: { id: true, supersededAt: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => `${r.id}:${r.supersededAt === null}`),
    c1Fund,
  );
  eq(
    "company 2's audit row is in company 2 only",
    await db.audit.count({
      where: {
        companyId: c.id,
        action: "financials.restated",
        summary: { contains: "Company two" },
      },
    }),
    0,
  );
  eq(
    "A of company 1 read under company 2: no holder month",
    await readHolderMonths(
      db,
      { companyId: w2.c.id, stakeholderId: A.id },
      { through: "2026-09-30" },
    ),
    [],
  );
  eq(
    "A of company 1 under company 2: no published-through date",
    await publishedThroughFor(db, { companyId: w2.c.id, stakeholderId: A.id }),
    null,
  );
  const c2Fund = await readFundMonths(db, w2.c.id, { through: "2026-09-30" });
  const c1Feb = (await readFundMonths(db, c.id, { through: "2026-02-28" })).at(
    -1,
  );
  check(
    "company 2's fund months are its own (no company 1 figures)",
    c2Fund.length === 9 &&
      c2Fund.every(
        (m) => m.paidInCapital === usd(80_000) || m.paidInCapital === 0n,
      ) &&
      c1Feb !== undefined &&
      c1Feb.paidInCapital === usd(350_000),
    `${c2Fund.length} months`,
  );
  const foreign = await errorOf(() =>
    w2.reports.reconcile({ publicId: pub.q1 as string }),
  );
  eq(
    "reconcile of company 1's report by company 2's admin is NOT_FOUND",
    (foreign as { code?: string } | null)?.code,
    "NOT_FOUND",
  );
  const foreignRestate = await errorOf(() =>
    inTx((tx) =>
      restateSnapshots(tx, {
        companyId: w2.c.id,
        fromMonth: "2026-01-01",
        toMonth: "2026-01-01",
        reason: "Nothing differs in January",
        actor: w2.restateActor,
      }),
    ),
  );
  check(
    "an unchanged month of company 2 is refused, company 1 untouched",
    /Nothing to restate/.test(foreignRestate?.message ?? ""),
  );
  void reports;
}

runScenarios([
  ["release Q1", releaseQ1],
  ["P38 gate", reconciliationGate],
  ["covered period", coveredPeriod],
  ["published-through", publishedThrough],
  ["frozen and restate", frozenThenRestate],
  ["concurrency", concurrency],
  ["isolation", isolation],
]);
