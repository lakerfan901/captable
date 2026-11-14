/**
 * Integration checks for E15 distributions
 * (src/server/llc/economics/distributions.ts) and the receipt date guards
 * (receipt-guards.ts) against the local database. Not part of `vitest run`.
 * Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=manager@example.com \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/distributions.integration.ts
 *
 * Call Notices are really sent, to the local mail catcher only. "Today" is
 * stepped with LLC_ECONOMICS_TODAY. Every row created is deleted at the end
 * (see harness.ts).
 */
import { fromDateOnly } from "@/lib/date-only";
import type { PositionsResult } from "@/lib/llc/positions";
import {
  recordCapitalReceipt,
  voidCapitalReceipt,
} from "@/server/llc/commitments";
import { recordCallNoticePayment } from "@/server/llc/economics/call-notices";
import {
  confirmCredit,
  confirmCure,
  confirmForfeiture,
  declareDefault,
  getDefaultView,
  recordDefaultFunding,
  recordDefaultPayment,
} from "@/server/llc/economics/defaults";
import {
  resendDistributionNotices,
  sendDistributionNotices,
} from "@/server/llc/economics/distribution-export";
import {
  computeDistribution,
  type DistributionInputs,
  deleteDistributionDraft,
  finalizeDistribution,
  getDistribution,
  reverseDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { getPositions } from "@/server/llc/economics/ledger";
import { applyUnitTransfer } from "@/server/llc/economics/transfers";
import {
  actor,
  buildWorkedCase,
  check,
  companyRef,
  createCompany,
  db,
  eq,
  errorOf,
  expectRefused,
  inTx,
  issueCommon,
  newMember,
  race,
  runScenarios,
  section,
  sendCall,
  setToday,
  subscribe,
  type TestCompany,
  type Tx,
  usd,
} from "./harness";

const U = 1_000_000n;
const P = "2027-05-14"; // payment date of every run here
const PERIOD_END = "2027-03-31";

const input = (c: TestCompany) => ({ company: companyRef(c), actor });

// ---------------------------------------------------------------------------
// Helpers

/**
 * Revenue months 2027-01..03 (all customer receipts in March), the $50,000
 * minimum operating reserve funded from capital, so Available Cash on
 * 2027-03-31 = receipts − the 5% Management Fee.
 */
async function cashLedger(c: TestCompany, marchReceiptsCents: bigint) {
  for (const month of ["2027-01-01", "2027-02-01", "2027-03-01"]) {
    const receipts = month === "2027-03-01" ? marchReceiptsCents : 0n;
    await db.revenuePeriod.create({
      data: {
        companyId: c.id,
        month: fromDateOnly(month),
        customerReceiptsCents: receipts,
        managementFeeBps: 500,
        managementFeeCents: roundDiv(receipts * 500n, 10_000n),
        updatedById: "harden-integration",
      },
    });
  }
  await db.reserveEntry.create({
    data: {
      companyId: c.id,
      effectiveOn: fromDateOnly("2027-01-01"),
      kind: "MINIMUM_OPERATING",
      type: "ESTABLISH",
      amountCents: usd(50_000),
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      reason: "Minimum operating reserve (integration)",
      createdById: "harden-integration",
    },
  });
}

function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  return 2n * (r < 0n ? -r : r) >= d ? q + (n < 0n ? -1n : 1n) : q;
}

function draft(
  c: TestCompany,
  inputs: DistributionInputs,
  opts: { periodEnd?: string; paymentDate?: string; id?: string } = {},
) {
  return inTx((tx) =>
    saveDistributionDraft(tx, {
      ...input(c),
      id: opts.id,
      type: inputs.type,
      periodStart: null,
      periodEnd: opts.periodEnd ?? PERIOD_END,
      paymentDate: opts.paymentDate ?? P,
      inputs,
      notes: null,
    }),
  );
}

const compute = (c: TestCompany, id: string) =>
  inTx((tx) => computeDistribution(tx, companyRef(c), id));

const finalize = (c: TestCompany, id: string, hash: string) => (tx: Tx) =>
  finalizeDistribution(tx, {
    ...input(c),
    id,
    expectedHash: hash,
    solvencyConfirmed: true,
  });

const reverse = (c: TestCompany, id: string) => (tx: Tx) =>
  reverseDistribution(tx, {
    ...input(c),
    id,
    reason: "Integration reversal check",
  });

async function positionsAt(c: TestCompany, asOf: string) {
  return (await inTx((tx) => getPositions(tx, c.id, asOf))).positions;
}

/** Every holder figure (lots included) as a canonical string. */
function fingerprint(p: PositionsResult): string {
  const rows = [...p.holders.values()]
    .sort((a, b) => (a.holderId < b.holderId ? -1 : 1))
    .map((h) => h);
  return JSON.stringify({ rows, totals: p.totals }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

const lineOf = <T extends { stakeholderId: string }>(lines: T[], id: string) =>
  lines.find((l) => l.stakeholderId === id);

/** Largest remainder, ties to the larger weight then the smaller key (R14), written independently of the library. */
function allocate(
  total: bigint,
  weights: [string, bigint][],
): Map<string, bigint> {
  const W = weights.reduce((s, [, w]) => s + w, 0n);
  const shares = weights.map(([k, w]) => ({
    k,
    w,
    share: (total * w) / W,
    rem: (total * w) % W,
  }));
  let left = total - shares.reduce((s, x) => s + x.share, 0n);
  const order = [...shares].sort((a, b) =>
    a.rem !== b.rem
      ? b.rem > a.rem
        ? 1
        : -1
      : a.w !== b.w
        ? b.w > a.w
          ? 1
          : -1
        : a.k < b.k
          ? -1
          : 1,
  );
  for (const x of order) {
    if (left === 0n) break;
    x.share += 1n;
    left -= 1n;
  }
  return new Map(shares.map((x) => [x.k, x.share]));
}

function days(from: string, to: string): bigint {
  return BigInt(
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ),
  );
}

/** Σ cents × days × 800 over lots, rounded once ÷ (365 × 10,000) (R4, R6). */
function accrued(lots: [bigint, string, string][]): bigint {
  const n = lots.reduce(
    (s, [amount, from, to]) => s + amount * days(from, to) * 800n,
    0n,
  );
  return roundDiv(n, 3_650_000n);
}

// ---------------------------------------------------------------------------
// DR-1 on Scenario S

async function scenarioS(label: string) {
  const c = await createCompany(label);
  const A = await newMember(c, "A Holder");
  const B = await newMember(c, "B Holder");
  const C = await newMember(c, "C Holder");
  const M = await newMember(c, "M Common", { isInsider: true });
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  await subscribe(c, B.id, usd(250_000), {
    cents: usd(250_000),
    receivedOn: "2026-11-23",
  });
  const cCommitment = await subscribe(c, C.id, usd(100_000), {
    cents: usd(40_000),
    receivedOn: "2026-11-30",
  });
  await issueCommon(c, M.id, "100", "2026-11-30");
  await sendCall(c, cCommitment, usd(60_000), "2027-01-14", "2027-01-20");
  setToday("2027-01-19");
  await inTx((tx) =>
    recordCallNoticePayment(tx, {
      ...input(c),
      commitmentId: cCommitment,
      receivedOn: "2027-01-19",
      amountCents: usd(60_000),
    }),
  );
  await cashLedger(c, usd(12_631.58));
  return { c, A, B, C, M, cCommitment };
}

async function dr1() {
  section(
    "DR-1: Scenario S, OPERATING, period end 2027-03-31, paid 2027-05-14",
  );
  const { c, A, B, C, M } = await scenarioS("dr1");
  await db.memberAdvance.create({
    data: {
      companyId: c.id,
      stakeholderId: B.id,
      paidOn: fromDateOnly("2027-04-15"),
      kind: "TAX_WITHHOLDING",
      amountCents: usd(2_500),
      createdById: "harden-integration",
    },
  });
  setToday(P);
  const before = await positionsAt(c, P);
  eq(
    "S-0 A unpaid $3,923.29",
    before.holders.get(A.id)?.unpaidReturn,
    usd(3_923.29),
  );
  eq(
    "S-0 B unpaid $9,424.66",
    before.holders.get(B.id)?.unpaidReturn,
    usd(9_424.66),
  );
  eq(
    "S-0 C unpaid $2,945.75",
    before.holders.get(C.id)?.unpaidReturn,
    usd(2_945.75),
  );
  eq(
    "S-0 total unreturned $450,000.00",
    before.totals.unreturned,
    usd(450_000),
  );

  const { id } = await draft(c, { type: "OPERATING" });
  const comp = await compute(c, id);
  eq("amount $12,000.00", comp.amount, usd(12_000));
  eq("no blockers", comp.blockers.map((b) => b.code).join(","), "");
  const a = lineOf(comp.lines, A.id);
  const b = lineOf(comp.lines, B.id);
  const cl = lineOf(comp.lines, C.id);
  const m = lineOf(comp.lines, M.id);
  eq("W-1 A tier C $2,889.43", a?.tierC, usd(2_889.43));
  eq("W-1 B tier C $6,941.08", b?.tierC, usd(6_941.08));
  eq("W-1 C tier C $2,169.49", cl?.tierC, usd(2_169.49));
  eq("M $0.00", m?.gross, 0n);
  eq("B tax advance offset $2,500.00", b?.taxAdvanceOffset, usd(2_500));
  eq("B net $4,441.08", b?.net, usd(4_441.08));
  eq("A net $2,889.43", a?.net, usd(2_889.43));
  eq("C net $2,169.49", cl?.net, usd(2_169.49));
  eq("A unpaid after $1,033.86", a?.unpaidReturnAfter, usd(1_033.86));
  eq("B unpaid after $2,483.58", b?.unpaidReturnAfter, usd(2_483.58));
  eq("C unpaid after $776.26", cl?.unpaidReturnAfter, usd(776.26));
  eq("totalNet $9,500.00", comp.totalNet, usd(9_500));

  await expectRefused(
    "finalize with a stale hash is CONFLICT",
    () => inTx(finalize(c, id, "0".repeat(64))),
    /Figures changed since review/,
    "CONFLICT",
  );
  await expectRefused(
    "finalize without the solvency confirmation refused",
    () =>
      inTx((tx) =>
        finalizeDistribution(tx, {
          ...input(c),
          id,
          expectedHash: comp.hash,
          solvencyConfirmed: false,
        }),
      ),
    /17-29-405/,
  );

  section("DR-1: two finalizes of the same draft in parallel");
  const fr = await race(finalize(c, id, comp.hash), finalize(c, id, comp.hash));
  check("finalize race: separate connections", fr.pids[0] !== fr.pids[1]);
  check("finalize race: second waited", fr.secondWaited);
  check("finalize race: first finalized", fr.first.ok);
  check(
    "finalize race: second CONFLICT (no longer a draft)",
    !fr.second.ok &&
      fr.second.code === "CONFLICT" &&
      /no longer a draft/.test(fr.second.message),
    fr.second.ok ? "succeeded" : fr.second.message,
  );
  const got = await inTx((tx) => getDistribution(tx, c.id, id));
  eq("status FINALIZED", got.distribution.status, "FINALIZED");
  eq("number 1", got.distribution.number, 1);
  eq("one line per holder (4)", got.lines.length, 4);
  eq(
    "Σ gross = amount",
    got.lines.reduce((s, l) => s + l.grossCents, 0n),
    got.distribution.amountCents,
  );
  eq(
    "one distribution number used",
    await db.distribution.count({
      where: { companyId: c.id, number: { not: null } },
    }),
    1,
  );
  eq(
    "one §9.2 recovery row",
    await db.memberAdvanceRecovery.count({ where: { companyId: c.id } }),
    1,
  );
  eq(
    "books closed through 2027-03-31",
    (
      await db.llcTerm.findFirstOrThrow({ where: { companyId: c.id } })
    ).booksClosedThrough
      ?.toISOString()
      .slice(0, 10),
    PERIOD_END,
  );
  const after = await positionsAt(c, P);
  eq(
    "A unpaid after finalize $1,033.86",
    after.holders.get(A.id)?.unpaidReturn,
    usd(1_033.86),
  );
  eq(
    "B unpaid after finalize $2,483.58",
    after.holders.get(B.id)?.unpaidReturn,
    usd(2_483.58),
  );

  await noticeResend(c, id, { A, B, C, M });

  section("B1: anything dated on the payment date of a finalized distribution");
  await expectRefused(
    "a same-day unit transfer is refused (it would sort before the distribution)",
    () =>
      inTx((tx) =>
        applyUnitTransfer(tx, {
          companyId: c.id,
          unitTransferId: "harden-transfer",
          fromStakeholderId: A.id,
          toStakeholderId: B.id,
          unitClassId: c.preferredId,
          units: "1",
          effectiveOn: fromDateOnly(P),
        }),
      ),
    /Distribution No\. 1 was paid on/,
  );

  section("DR-1: reverse (and a parallel second reverse)");
  const rr = await race(reverse(c, id), reverse(c, id));
  check("reverse race: second waited", rr.secondWaited);
  check(
    "reverse race: first reversed",
    rr.first.ok,
    rr.first.ok ? "" : rr.first.message,
  );
  check(
    "reverse race: second CONFLICT (already reversed)",
    !rr.second.ok && rr.second.code === "CONFLICT",
    rr.second.ok ? "succeeded" : rr.second.message,
  );
  eq(
    "exactly one reversal distribution",
    await db.distribution.count({
      where: { companyId: c.id, isReversal: true },
    }),
    1,
  );
  const reversed = await positionsAt(c, P);
  eq(
    "positions after reverse = positions before the run",
    fingerprint(reversed),
    fingerprint(before),
  );
  eq(
    "recovery reversed (net 0 recovered)",
    (
      await db.memberAdvanceRecovery.aggregate({
        where: { companyId: c.id },
        _sum: { amountCents: true },
      })
    )._sum.amountCents,
    0n,
  );

  await blockers(c, { A, B, C, M });
  await finalizeVsReverse(c);
  await tenantIsolation(c, id);
}

/**
 * E17 notices, then re-sends (a bounced or corrected address): same notice to
 * the current address, an audit row naming it, one email per double click,
 * and no economic column touched.
 */
async function noticeResend(
  c: TestCompany,
  distributionId: string,
  h: Record<"A" | "B" | "C" | "M", { id: string }>,
) {
  section("E17: notices sent once, then re-sent to a corrected address");
  const manager = { name: "Integration Manager", email: "manager@example.com" };
  const who = { company: companyRef(c), actor, manager };
  const money = async () =>
    JSON.stringify(
      (
        await db.distributionLine.findMany({
          where: { distributionId },
          orderBy: { id: "asc" },
        })
      ).map(
        ({
          noticeSentAt: _a,
          noticeEmailLogId: _b,
          noticeSendCount: _c,
          noticeResendingAt: _d,
          noticeLastSentAt: _e,
          updatedAt: _f,
          ...economic
        }) => economic,
      ),
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    ) +
    JSON.stringify(
      await db.distribution.findFirstOrThrow({ where: { id: distributionId } }),
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
  const positions = fingerprint(await positionsAt(c, P));
  const before = await money();
  const lineFor = async (stakeholderId: string) =>
    db.distributionLine.findFirstOrThrow({
      where: { distributionId, stakeholderId },
    });
  const logsFor = async (lineId: string) =>
    db.emailLog.findMany({
      where: { relatedType: "distributionLine", relatedId: lineId },
      orderBy: { createdAt: "asc" },
    });

  const first = await sendDistributionNotices(db, {
    ...who,
    id: distributionId,
  });
  eq(
    "first send: A, B, C sent; M (nothing distributed) skipped",
    first.results
      .map((r) => r.status)
      .sort()
      .join(","),
    "SENT,SENT,SENT,SKIPPED",
  );
  const a1 = await lineFor(h.A.id);
  eq("A: one accepted notice", a1.noticeSendCount, 1);
  check("A: first email logged", a1.noticeEmailLogId !== null);

  const resend = (lines: { lineId: string; sendCount: number }[]) =>
    resendDistributionNotices(db, { ...who, id: distributionId, lines });

  const m = await lineFor(h.M.id);
  eq(
    "re-send of a line never sent is skipped (M)",
    (await resend([{ lineId: m.id, sendCount: 0 }])).results[0]?.reason,
    "No notice was sent for this line yet; use Send notices.",
  );

  // The address bounced: the Manager corrects it, then re-sends.
  const corrected = `corrected-${c.id.slice(-6)}@example.com`;
  await db.stakeholder.update({
    where: { id: h.A.id },
    data: { noticeEmail: corrected },
  });
  const [r1, r2] = await Promise.all([
    resend([{ lineId: a1.id, sendCount: 1 }]),
    resend([{ lineId: a1.id, sendCount: 1 }]),
  ]);
  eq(
    "double click: exactly one re-send sent, the other skipped",
    [r1.results[0]?.status, r2.results[0]?.status].sort().join(","),
    "SENT,SKIPPED",
  );
  const a2 = await lineFor(h.A.id);
  eq("A: two accepted notices", a2.noticeSendCount, 2);
  eq(
    "A: the first send stays on record (noticeSentAt)",
    a2.noticeSentAt?.toISOString(),
    a1.noticeSentAt?.toISOString(),
  );
  eq(
    "A: the first email log id stays",
    a2.noticeEmailLogId,
    a1.noticeEmailLogId,
  );
  check("A: last re-send time set", a2.noticeLastSentAt !== null);
  eq("A: no claim left", a2.noticeResendingAt, null);
  const logs = await logsFor(a1.id);
  eq("A: two emails logged for the line", logs.length, 2);
  eq(
    "A: the re-send went to the corrected address",
    logs[1]?.toAddress,
    corrected,
  );
  const audits = await db.audit.findMany({
    where: { companyId: c.id, action: "distribution.notice-resent" },
  });
  eq("one re-send audit row", audits.length, 1);
  check(
    "the audit row names the address",
    audits[0]?.summary?.includes(corrected) === true,
    audits[0]?.summary ?? "",
  );

  const stale = await resend([{ lineId: a1.id, sendCount: 1 }]);
  eq(
    "a later request with the old count sends nothing",
    stale.results[0]?.status,
    "SKIPPED",
  );
  eq("A: still two emails", (await logsFor(a1.id)).length, 2);

  const [b, cl] = [await lineFor(h.B.id), await lineFor(h.C.id)];
  const all = await resend([
    { lineId: a1.id, sendCount: 2 },
    { lineId: b.id, sendCount: b.noticeSendCount },
    { lineId: cl.id, sendCount: cl.noticeSendCount },
  ]);
  eq(
    "re-send of the whole distribution: three sent",
    all.results.map((r) => r.status).join(","),
    "SENT,SENT,SENT",
  );
  eq(
    "re-send audit rows: four",
    await db.audit.count({
      where: { companyId: c.id, action: "distribution.notice-resent" },
    }),
    4,
  );

  const penv = process.env as Record<string, string | undefined>;
  const previous = penv.NODE_ENV;
  penv.NODE_ENV = "production";
  try {
    await expectRefused(
      "production with the mail catcher: re-send refused",
      () => resend([{ lineId: b.id, sendCount: 2 }]),
      /Set EMAIL_SERVER and EMAIL_FROM before sending distribution notices/,
      "BAD_REQUEST",
    );
  } finally {
    penv.NODE_ENV = previous;
  }
  eq(
    "B: count unchanged after the refusal",
    (await lineFor(h.B.id)).noticeSendCount,
    2,
  );

  eq(
    "no economic column of the lines or the distribution changed",
    await money(),
    before,
  );
  eq("positions unchanged", fingerprint(await positionsAt(c, P)), positions);
}

async function blockers(
  c: TestCompany,
  h: {
    A: { id: string };
    B: { id: string };
    C: { id: string };
    M: { id: string };
  },
) {
  section("Blockers reachable with honest rows");
  setToday(P);
  const codes = async (
    inputs: DistributionInputs,
    opts: { periodEnd?: string; paymentDate?: string } = {},
  ) => {
    const { id } = await draft(c, inputs, opts);
    const comp = await compute(c, id);
    await inTx((tx) => deleteDistributionDraft(tx, { ...input(c), id }));
    return comp.blockers.map((b) => b.code);
  };
  const has = async (
    code: string,
    inputs: DistributionInputs,
    opts: { periodEnd?: string; paymentDate?: string } = {},
  ) => {
    const found = await codes(inputs, opts);
    check(`blocker ${code}`, found.includes(code), found.join(","));
  };
  await has(
    "PERIOD_END_NOT_MONTH_END",
    { type: "OPERATING" },
    { periodEnd: "2027-03-30" },
  );
  await has(
    "PAYMENT_BEFORE_PERIOD_END",
    { type: "OPERATING" },
    { paymentDate: "2027-03-30" },
  );
  await has(
    "PAYMENT_BEFORE_LEDGER_EVENT",
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 100 },
    { periodEnd: "2027-01-10", paymentDate: "2027-01-18" },
  );
  await has(
    "PAYMENT_TOO_FAR_AHEAD",
    { type: "OPERATING" },
    { paymentDate: "2027-05-29" },
  );
  await has("AMOUNT_ZERO", { type: "OPERATING" }, { periodEnd: "2027-02-28" });
  await has(
    "PERIOD_CLOSED",
    { type: "OPERATING" },
    { periodEnd: "2027-02-28" },
  );
  await has(
    "MISSING_REVENUE_MONTH",
    { type: "OPERATING" },
    { periodEnd: "2027-04-30" },
  );
  await has("EXCEEDS_UNUSED_CAPITAL", {
    type: "RETURN_OF_UNUSED_CAPITAL",
    amountCents: 45_000_000,
  });
  await has("EXCEEDS_UNRETURNED_CAPITAL", {
    type: "RETURN_OF_UNUSED_CAPITAL",
    amountCents: 46_000_000,
  });
  await has("INSUFFICIENT_FOR_CREDITORS", {
    type: "SALE_OR_LIQUIDATION",
    liquidation: {
      cashAvailableCents: 100_000,
      windDownReserveCents: 0,
      creditors: [
        {
          payee: "Trade",
          amountCents: 200_000,
          memo: "",
          managerCategory: null,
        },
      ],
      isFinal: true,
    },
  });
  // MIN_RESERVE: release part of the minimum reserve.
  const release = await db.reserveEntry.create({
    data: {
      companyId: c.id,
      effectiveOn: fromDateOnly("2027-03-01"),
      kind: "MINIMUM_OPERATING",
      type: "RELEASE",
      amountCents: usd(10_000),
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      reason: "integration",
      createdById: "harden-integration",
    },
  });
  await has("MIN_RESERVE", { type: "OPERATING" });
  await db.reserveEntry.delete({ where: { id: release.id } });
  // LOAN_PAST_MATURITY: a member loan matured on the payment date.
  const loan = await db.memberLoan.create({
    data: {
      companyId: c.id,
      lenderStakeholderId: h.A.id,
      principalCents: usd(1_000),
      interestBps: 500,
      madeOn: fromDateOnly("2027-01-05"),
      maturityOn: fromDateOnly(P),
      createdById: "harden-integration",
    },
  });
  await has("LOAN_PAST_MATURITY", { type: "OPERATING" });
  await db.memberLoan.delete({ where: { id: loan.id } });
  // TERMS_INCOMPLETE: no Balance outside date on the Preferred class.
  await db.unitClass.update({
    where: { id: c.preferredId },
    data: { balanceOutsideDate: null },
  });
  await has("TERMS_INCOMPLETE", { type: "OPERATING" });
  await db.unitClass.update({
    where: { id: c.preferredId },
    data: { balanceOutsideDate: fromDateOnly("2027-03-31") },
  });
  void h;
}

async function finalizeVsReverse(c: TestCompany) {
  section("finalize vs reverse, in both orders");
  setToday(P);
  const d1 = await draft(c, { type: "OPERATING" });
  const c1 = await compute(c, d1.id);
  await inTx(finalize(c, d1.id, c1.hash));
  const d2 = await draft(c, {
    type: "RETURN_OF_UNUSED_CAPITAL",
    amountCents: 1_000_000,
  });
  const c2 = await compute(c, d2.id);
  eq(
    "return of capital computes without blockers",
    c2.blockers.map((b) => b.code).join(","),
    "",
  );
  const r1 = await race(finalize(c, d2.id, c2.hash), reverse(c, d1.id));
  check("finalize first: the reverse waited", r1.secondWaited);
  check(
    "finalize first: finalize succeeded",
    r1.first.ok,
    r1.first.ok ? "" : r1.first.message,
  );
  check(
    "finalize first: reverse of the older one refused (only the latest)",
    !r1.second.ok &&
      /Only the latest finalized distribution/.test(r1.second.message),
    r1.second.ok ? "succeeded" : r1.second.message,
  );
  const d3 = await draft(c, {
    type: "RETURN_OF_UNUSED_CAPITAL",
    amountCents: 500_000,
  });
  const c3 = await compute(c, d3.id);
  const r2 = await race(reverse(c, d2.id), finalize(c, d3.id, c3.hash));
  check("reverse first: the finalize waited", r2.secondWaited);
  check(
    "reverse first: reverse succeeded",
    r2.first.ok,
    r2.first.ok ? "" : r2.first.message,
  );
  // After the reverse the finalize recomputes under the lock: a changed
  // figure is CONFLICT; unchanged figures (a pro rata tier (d) split keeps
  // its proportions) finalize on the recomputed positions, which finalize
  // itself proves by replaying the ledger before it commits.
  check(
    "reverse first: finalize then refused only as CONFLICT, or finalized on recomputed figures",
    r2.second.ok || r2.second.code === "CONFLICT",
    r2.second.ok ? "" : r2.second.message,
  );
  if (r2.second.ok) {
    // Its frozen lines must carry the positions after the reverse (D1 only),
    // not the ones reviewed while D2 still stood.
    const recomputed = await inTx((tx) => getDistribution(tx, c.id, d3.id));
    const ledger = (await inTx((tx) => getPositions(tx, c.id, P))).ledger;
    const event = ledger.events.find(
      (e) => e.kind === "DISTRIBUTION" && e.distributionId === d3.id,
    );
    const atD3 = event
      ? (await inTx((tx) => getPositions(tx, c.id, P, { untilSeq: event.seq })))
          .positions
      : null;
    check(
      "the late finalize froze the recomputed unreturned capital",
      atD3 !== null &&
        recomputed.lines.every(
          (l) =>
            (atD3.holders.get(l.stakeholderId)?.unreturned ?? 0n) ===
            l.unreturnedBeforeCents,
        ),
      recomputed.distribution.status,
    );
    await inTx(reverse(c, d3.id));
  } else {
    await inTx((tx) => deleteDistributionDraft(tx, { ...input(c), id: d3.id }));
  }
  // Leave the company clean for the isolation checks.
  await inTx(reverse(c, d1.id));
}

async function tenantIsolation(c: TestCompany, distributionId: string) {
  section("Tenant isolation: distributions of another company");
  const other = await createCompany("dist-other");
  const o = input(other);
  const { id: draftId } = await draft(c, { type: "OPERATING" });
  const cases: [string, () => Promise<unknown>][] = [
    [
      "getDistribution",
      () => inTx((tx) => getDistribution(tx, other.id, distributionId)),
    ],
    [
      "computeDistribution",
      () => inTx((tx) => computeDistribution(tx, companyRef(other), draftId)),
    ],
    [
      "saveDistributionDraft (update)",
      () =>
        inTx((tx) =>
          saveDistributionDraft(tx, {
            ...o,
            id: draftId,
            type: "OPERATING",
            periodStart: null,
            periodEnd: PERIOD_END,
            paymentDate: P,
            inputs: { type: "OPERATING" },
            notes: null,
          }),
        ),
    ],
    [
      "deleteDistributionDraft",
      () => inTx((tx) => deleteDistributionDraft(tx, { ...o, id: draftId })),
    ],
    [
      "finalizeDistribution",
      () =>
        inTx((tx) =>
          finalizeDistribution(tx, {
            ...o,
            id: draftId,
            expectedHash: "0".repeat(64),
            solvencyConfirmed: true,
          }),
        ),
    ],
    [
      "reverseDistribution",
      () =>
        inTx((tx) =>
          reverseDistribution(tx, {
            ...o,
            id: distributionId,
            reason: "tenant isolation check",
          }),
        ),
    ],
  ];
  for (const [name, run] of cases) {
    await expectRefused(
      `${name} refuses a foreign id`,
      run,
      /not found/i,
      "NOT_FOUND",
    );
  }
  eq(
    "the draft is untouched",
    (await db.distribution.findFirstOrThrow({ where: { id: draftId } })).status,
    "DRAFT",
  );
  await inTx((tx) => deleteDistributionDraft(tx, { ...input(c), id: draftId }));
}

// ---------------------------------------------------------------------------
// Finalize racing a receipt recorded through FOUNDATION (Commitments page)

async function finalizeVsReceipt() {
  section("finalize vs a capital receipt recorded on the Commitments page");
  const c = await createCompany("dist-race");
  const A = await newMember(c, "A Holder");
  const X = await newMember(c, "X Partly Paid");
  const M = await newMember(c, "M Common");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  const xCommitment = await subscribe(c, X.id, usd(100_000), {
    cents: usd(40_000),
    receivedOn: "2026-11-30",
  });
  await issueCommon(c, M.id, "100", "2026-11-30");
  await cashLedger(c, usd(12_631.58));
  setToday(P);
  const receipt = (on: string, cents: bigint) => (tx: Tx) =>
    recordCapitalReceipt(
      tx,
      {
        companyId: c.id,
        commitmentId: xCommitment,
        receivedOn: on,
        amountCents: cents,
      },
      actor,
    );

  // Order 1: finalize holds its transaction open; the receipt arrives meanwhile.
  const d1 = await draft(c, { type: "OPERATING" });
  const c1 = await compute(c, d1.id);
  const o1 = await race(finalize(c, d1.id, c1.hash), receipt(P, usd(10_000)));
  check(
    "finalize first: finalize succeeded",
    o1.first.ok,
    o1.first.ok ? "" : o1.first.message,
  );
  check("finalize first: the receipt waited for the finalize", o1.secondWaited);
  check(
    "finalize first: a receipt dated on the payment date is refused",
    !o1.second.ok && /Distribution No\. 1 was paid on/.test(o1.second.message),
    o1.second.ok ? "it was recorded" : o1.second.message,
  );
  const dist = await inTx((tx) => getDistribution(tx, c.id, d1.id));
  const ledger = await inTx((tx) => getPositions(tx, c.id, P));
  const event = ledger.ledger.events.find(
    (e) => e.kind === "DISTRIBUTION" && e.distributionId === d1.id,
  );
  const replay = event
    ? (await inTx((tx) => getPositions(tx, c.id, P, { untilSeq: event.seq })))
        .positions
    : null;
  check(
    "the finalized lines agree with the ledger replayed up to the distribution",
    replay !== null &&
      dist.lines.every(
        (l) =>
          (replay.holders.get(l.stakeholderId)?.preferredUnits ?? 0n) ===
          l.preferredUnits,
      ),
    replay
      ? dist.lines
          .map(
            (l) =>
              `${l.stakeholderId.slice(-4)} line ${l.preferredUnits} ledger ${replay.holders.get(l.stakeholderId)?.preferredUnits ?? 0n}`,
          )
          .join("; ")
      : "no distribution event",
  );
  // Clean the slate: void a receipt that slipped in, reverse the distribution.
  if (o1.second.ok) {
    await inTx(reverse(c, d1.id));
    await inTx((tx) =>
      voidCapitalReceipt(
        tx,
        {
          companyId: c.id,
          receiptId: o1.second.ok ? o1.second.value.id : "",
          reason: "integration cleanup",
        },
        actor,
      ),
    );
  } else {
    await inTx(reverse(c, d1.id));
  }

  // Order 2: the receipt holds its transaction open; finalize arrives meanwhile.
  const d2 = await draft(c, { type: "OPERATING" });
  const c2 = await compute(c, d2.id);
  const o2 = await race(receipt(P, usd(10_000)), finalize(c, d2.id, c2.hash));
  check(
    "receipt first: receipt recorded",
    o2.first.ok,
    o2.first.ok ? "" : o2.first.message,
  );
  check("receipt first: finalize waited for the receipt", o2.secondWaited);
  // The receipt is dated the payment date, so it accrues nothing by then and
  // the money figures (the hash) are unchanged: finalize may go ahead, but
  // only on positions that include the receipt.
  if (!o2.second.ok) {
    check(
      "receipt first: finalize refused only as CONFLICT",
      o2.second.code === "CONFLICT",
      o2.second.message,
    );
    const c3 = await compute(c, d2.id);
    await inTx(finalize(c, d2.id, c3.hash));
  }
  const xLine = lineOf(
    (await inTx((tx) => getDistribution(tx, c.id, d2.id))).lines,
    X.id,
  );
  eq(
    "X's finalized line counts the same-day receipt (50 units)",
    xLine?.preferredUnits,
    50n * U,
  );
  if (o2.first.ok) {
    const receiptId = o2.first.value.id;
    await expectRefused(
      "voiding a same-day receipt the distribution was computed on is refused",
      () =>
        inTx((tx) =>
          voidCapitalReceipt(
            tx,
            { companyId: c.id, receiptId, reason: "integration void" },
            actor,
          ),
        ),
      /Reverse distribution No\. \d+ first/,
    );
  }
}

// ---------------------------------------------------------------------------
// The worked-case default netted in a distribution (DR-2 analogue)

async function offsetRun() {
  section("Default offset (DR-2 analogue on the E11 worked case)");
  const c = await createCompany("dist-offset");
  // Before the credit: the run is blocked by the pending step.
  const w = await buildWorkedCase(c, { stopBeforeCredit: true });
  await cashLedger(c, usd(12_631.58));
  setToday("2027-02-19");
  {
    const { id } = await draft(
      c,
      { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 100_000 },
      {
        periodEnd: "2027-02-19",
        paymentDate: "2027-02-19",
      },
    );
    const comp = await compute(c, id);
    check(
      "PENDING_DEFAULT_STEP while the credit is due",
      comp.blockers.some(
        (b) => b.code === "PENDING_DEFAULT_STEP" && /credit/.test(b.message),
      ),
      comp.blockers.map((b) => b.code).join(","),
    );
    await inTx((tx) => deleteDistributionDraft(tx, { ...input(c), id }));
  }
  await inTx((tx) =>
    confirmCredit(tx, {
      ...input(c),
      id: w.defaultId,
      expectedPoolACents: usd(11_250),
      expectedPoolBCents: usd(22_500),
    }),
  );

  // Hand-derived expectations (R4, R6, R9, R14, R17): unpaid return on
  // 2027-05-14 per holder from the lots, then tier (c) pro rata.
  const unpaid = new Map<string, bigint>([
    [
      w.A.id,
      accrued([
        [usd(100_000), "2026-11-16", P],
        [usd(30_000), "2027-01-25", P],
        [usd(13_125), "2027-02-19", P],
      ]),
    ],
    [
      w.B.id,
      accrued([
        [usd(250_000), "2026-11-23", P],
        [usd(14_062.5), "2027-02-19", P],
      ]),
    ],
    [
      w.K.id,
      accrued([
        [usd(50_000), "2026-11-20", P],
        [usd(15_000), "2027-02-01", P],
        [usd(2_812.5), "2027-02-19", P],
      ]),
    ],
    [
      w.C.id,
      accrued([
        [usd(40_000), "2026-11-30", "2027-01-27"],
        [usd(10_000), "2027-01-27", P],
      ]) - usd(381.37),
    ],
  ]);
  const tierC = allocate(
    usd(12_000),
    [...unpaid.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
  const cGross = tierC.get(w.C.id) ?? -1n;

  // Finalize before the payment date: the offset receipt would be in the future.
  setToday("2027-05-10");
  const { id } = await draft(c, { type: "OPERATING" });
  const early = await compute(c, id);
  const future = early.blockers.find(
    (b) => b.code === "OFFSET_RECEIPT_IN_FUTURE",
  );
  check(
    "OFFSET_RECEIPT_IN_FUTURE before the payment date, telling the Manager when to finalize",
    future !== undefined &&
      /Finalize on or after the payment date/.test(future.message),
    early.blockers.map((b) => `${b.code}: ${b.message}`).join(" | "),
  );

  setToday(P);
  const before = await positionsAt(c, P);
  for (const [holder, value] of unpaid) {
    eq(
      `unpaid return of ${holder.slice(-4)} on ${P} (hand-derived)`,
      before.holders.get(holder)?.unpaidReturn,
      value,
    );
  }
  const comp = await compute(c, id);
  eq(
    "no blockers on the payment date",
    comp.blockers.map((b) => b.code).join(","),
    "",
  );
  for (const [holder, share] of tierC) {
    eq(
      `tier C of ${holder.slice(-4)} (hand-derived)`,
      lineOf(comp.lines, holder)?.tierC,
      share,
    );
  }
  const cLine = lineOf(comp.lines, w.C.id);
  eq(
    "C's whole line is withheld for the Balance",
    cLine?.defaultOffsetBalance,
    cGross,
  );
  eq("C net $0.00", cLine?.net, 0n);
  eq("totalNet = amount − C's line", comp.totalNet, usd(12_000) - cGross);

  // Order 1 of "default payment vs offset": a cash default payment holds its
  // transaction open while finalize waits; finalize then recomputes.
  const pay = (paidOn: string, cents: bigint, toBalance: bigint) => (tx: Tx) =>
    recordDefaultPayment(tx, {
      ...input(c),
      id: w.defaultId,
      paidOn,
      amountCents: cents,
      expected: {
        toBalanceCents: toBalance,
        toInterestCents: 0n,
        toCostsCents: 0n,
      },
    });
  const o1 = await race(
    pay(P, usd(1_000), usd(1_000)),
    finalize(c, id, comp.hash),
  );
  check(
    "payment first: payment recorded",
    o1.first.ok,
    o1.first.ok ? "" : o1.first.message,
  );
  check("payment first: finalize waited", o1.secondWaited);
  check(
    "payment first: finalize succeeds on figures still equal (offset unchanged)",
    o1.second.ok,
    o1.second.ok ? "" : o1.second.message,
  );
  const dist = await inTx((tx) => getDistribution(tx, c.id, id));
  const offsetReceipts = await db.capitalReceipt.findMany({
    where: { companyId: c.id, sourceType: "distribution", sourceId: id },
  });
  eq("one offset receipt", offsetReceipts.length, 1);
  eq(
    "offset receipt amount = C's line",
    offsetReceipts[0]?.appliedCents,
    cGross,
  );
  eq(
    "offset receipt dated the payment date",
    offsetReceipts[0]?.appliedOn?.toISOString().slice(0, 10),
    P,
  );
  eq(
    "offset receipt units = amount / $1,000",
    offsetReceipts[0]?.unitsIssued.toFixed(6),
    (Number(cGross) / 100_000).toFixed(6),
  );
  eq(
    "one DISTRIBUTION_OFFSET default payment",
    await db.memberDefaultPayment.count({
      where: { companyId: c.id, source: "DISTRIBUTION_OFFSET" },
    }),
    1,
  );
  eq("distribution No. 1", dist.distribution.number, 1);

  // Order 2: finalize is done; a cash payment dated the payment date would
  // add a receipt that sorts BEFORE the distribution (defect 7).
  await expectRefused(
    "a Balance payment dated on the payment date of a finalized distribution is refused",
    () => inTx(pay(P, usd(1_000), usd(1_000))),
    /Distribution No\. 1 was paid on/,
  );
  // An ordinary receipt the day after is fine.
  setToday("2027-05-15");
  check(
    "a payment the day after is accepted",
    (await errorOf(() => inTx(pay("2027-05-15", usd(500), usd(500))))) === null,
  );
  {
    const late = await draft(c, {
      type: "RETURN_OF_UNUSED_CAPITAL",
      amountCents: 100_000,
    });
    const lc = await compute(c, late.id);
    check(
      "blocker OFFSET_DATE_ORDER (a default payment dated after the payment date)",
      lc.blockers.some((b) => b.code === "OFFSET_DATE_ORDER"),
      lc.blockers.map((b) => b.code).join(","),
    );
    const liq = await draft(
      c,
      {
        type: "SALE_OR_LIQUIDATION",
        liquidation: {
          cashAvailableCents: 60_000_000,
          windDownReserveCents: 0,
          creditors: [],
          isFinal: true,
        },
      },
      { periodEnd: "2027-05-15", paymentDate: "2027-05-15" },
    );
    const lq = await compute(c, liq.id);
    check(
      "blocker NO_UNITS_IN_CLASS (tier (e) with no Common Units issued)",
      lq.blockers.some((b) => b.code === "NO_UNITS_IN_CLASS"),
      lq.blockers.map((b) => b.code).join(","),
    );
    await inTx((tx) =>
      deleteDistributionDraft(tx, { ...input(c), id: late.id }),
    );
    await inTx((tx) =>
      deleteDistributionDraft(tx, { ...input(c), id: liq.id }),
    );
  }

  section("B1: two distributions on one payment date, reverse the later one");
  // No. 2 and No. 3 on 2027-05-15 (returns of unused capital), each with its
  // own offset receipt for C. Reversing No. 3 voids its offset receipt; No. 2,
  // paid the same day, is ordered before that receipt and did not depend on it.
  const pos1 = await positionsAt(c, "2027-05-15");
  const d2 = await draft(
    c,
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 1_000_000 },
    {
      periodEnd: "2027-05-15",
      paymentDate: "2027-05-15",
    },
  );
  const c2 = await compute(c, d2.id);
  eq(
    "No. 2 computes without blockers",
    c2.blockers.map((b) => b.code).join(","),
    "",
  );
  // Order 2 of "default payment vs offset": finalize holds its transaction
  // open; a cash payment dated the same day arrives meanwhile.
  const o2 = await race(
    finalize(c, d2.id, c2.hash),
    pay("2027-05-15", usd(100), usd(100)),
  );
  check(
    "finalize first: No. 2 finalized",
    o2.first.ok,
    o2.first.ok ? "" : o2.first.message,
  );
  check("finalize first: the payment waited", o2.secondWaited);
  check(
    "finalize first: the same-day Balance payment is then refused",
    !o2.second.ok &&
      /Distribution No\. 2 was paid on May 15, 2027, the date this receipt takes effect/.test(
        o2.second.message,
      ),
    o2.second.ok ? "it was recorded" : o2.second.message,
  );
  const d3 = await draft(
    c,
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 500_000 },
    {
      periodEnd: "2027-05-15",
      paymentDate: "2027-05-15",
    },
  );
  const c3 = await compute(c, d3.id);
  eq(
    "No. 3 on the same date computes without blockers",
    c3.blockers.map((b) => b.code).join(","),
    "",
  );
  await inTx(finalize(c, d3.id, c3.hash));
  const r3 = await errorOf(() => inTx(reverse(c, d3.id)));
  check(
    "reversing No. 3 is not blocked by No. 2 paid the same day",
    r3 === null,
    r3?.message ?? "",
  );
  check(
    "then reversing No. 2 works",
    (await errorOf(() => inTx(reverse(c, d2.id)))) === null,
  );
  eq(
    "positions after both reversals = before No. 2",
    fingerprint(await positionsAt(c, "2027-05-15")),
    fingerprint(pos1),
  );

  section("Reverse No. 1 (offset receipt voided, positions as before the run)");
  const ledger = (await inTx((tx) => getPositions(tx, c.id, P))).ledger;
  const event = ledger.events.find(
    (e) => e.kind === "DISTRIBUTION" && e.distributionId === id,
  );
  const beforeRun = event
    ? (await inTx((tx) => getPositions(tx, c.id, P, { untilSeq: event.seq })))
        .positions
    : null;
  check("No. 1 is in the ledger", beforeRun !== null);
  await inTx(reverse(c, id));
  if (beforeRun) {
    eq(
      "positions on the payment date after the reverse = before the run",
      fingerprint(await positionsAt(c, P)),
      fingerprint(beforeRun),
    );
  }
  const voided = await db.capitalReceipt.findFirstOrThrow({
    where: { id: offsetReceipts[0]?.id ?? "" },
  });
  check("No. 1's offset receipt voided", voided.voidedAt !== null);
  eq(
    "its default payment has a reversal row",
    await db.memberDefaultPayment.count({
      where: {
        companyId: c.id,
        source: "DISTRIBUTION_OFFSET",
        reversesPaymentId: { not: null },
      },
    }),
    await db.memberDefaultPayment.count({
      where: {
        companyId: c.id,
        source: "DISTRIBUTION_OFFSET",
        reversesPaymentId: null,
      },
    }),
  );
  eq(
    "C's line is open again",
    (await db.callNoticeLine.findFirstOrThrow({ where: { id: w.lineId } }))
      .status,
    "SENT",
  );
}

// ---------------------------------------------------------------------------
// DEFAULT_EXCESS_HELD: fully replacement-funded, credit not yet confirmed.

async function excessHeld() {
  section(
    "Blocker DEFAULT_EXCESS_HELD (Balance fully funded, credit pending, interest owed)",
  );
  const c = await createCompany("dist-excess");
  const A = await newMember(c, "A Holder");
  const B = await newMember(c, "B Holder");
  const C = await newMember(c, "C Defaulter");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  await subscribe(c, B.id, usd(250_000), {
    cents: usd(250_000),
    receivedOn: "2026-11-23",
  });
  const cCommitment = await subscribe(c, C.id, usd(100_000), {
    cents: usd(40_000),
    receivedOn: "2026-11-30",
  });
  const call = await sendCall(
    c,
    cCommitment,
    usd(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  setToday("2027-01-21");
  const d = await inTx((tx) =>
    declareDefault(tx, {
      ...input(c),
      callNoticeLineId: call.lineId,
      expectedUnpaidCents: usd(60_000),
    }),
  );
  setToday("2027-01-25");
  await inTx((tx) =>
    recordDefaultFunding(tx, {
      ...input(c),
      id: d.id,
      funderStakeholderId: A.id,
      amountCents: usd(30_000),
      fundedOn: "2027-01-25",
    }),
  );
  setToday("2027-01-28");
  await inTx((tx) =>
    confirmForfeiture(tx, {
      ...input(c),
      id: d.id,
      expectedForfeitedCents: usd(30_000),
      expectedUnitsAfter: 10n * U,
    }),
  );
  setToday("2027-02-03");
  await inTx((tx) =>
    recordDefaultFunding(tx, {
      ...input(c),
      id: d.id,
      funderStakeholderId: B.id,
      amountCents: usd(30_000),
      fundedOn: "2027-02-03",
    }),
  );
  const { id } = await draft(
    c,
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 10_000_000 },
    {
      periodEnd: "2027-02-03",
      paymentDate: "2027-02-03",
    },
  );
  const comp = await compute(c, id);
  const codes = comp.blockers.map((b) => b.code);
  check(
    "blocker DEFAULT_EXCESS_HELD",
    codes.includes("DEFAULT_EXCESS_HELD"),
    codes.join(","),
  );

  section(
    "Cure by replacement funding (R37 route 2), then interest-only netting (R18)",
  );
  // Hand-derived: poolA = 30,000 × 50% × 60,000 / 60,000 = 15,000; poolB =
  // 30,000 − 15,000 = 15,000. Interest = (60,000 × 5 + 30,000 × 9) × 12% / 365
  // = 187.397… → $187.40.
  await inTx((tx) =>
    confirmCredit(tx, {
      ...input(c),
      id: d.id,
      expectedPoolACents: usd(15_000),
      expectedPoolBCents: usd(15_000),
      expectedCreditDate: "2027-02-03",
    }),
  );
  const view = (asOf: string) =>
    inTx((tx) => getDefaultView(tx, c.id, d.id, asOf));
  const v = await view("2027-02-03");
  eq("cure method REPLACEMENT_FUNDED", v.cure.method, "REPLACEMENT_FUNDED");
  eq(
    "cured on 2027-02-03 (funded in full and credited)",
    v.cure.curedOn,
    "2027-02-03",
  );
  eq("interest owed $187.40", v.interestOwed, usd(187.4));
  await inTx((tx) =>
    confirmCure(tx, { ...input(c), id: d.id, expectedCuredOn: "2027-02-03" }),
  );
  const cured = await view("2027-02-03");
  eq("status CURED", cured.status, "CURED");
  eq(
    "interest still owed after the cure (R18)",
    cured.interestOwed,
    usd(187.4),
  );
  // A payment dated on the Credit Date is refused once the credit is
  // confirmed (E11 date order), so the run is paid the next day.
  const sameDay = await compute(c, id);
  check(
    "a run paid on the confirmed Credit Date is blocked (OFFSET_DATE_ORDER)",
    sameDay.blockers.some((b) => b.code === "OFFSET_DATE_ORDER"),
    sameDay.blockers.map((b) => b.code).join(","),
  );
  await inTx((tx) => deleteDistributionDraft(tx, { ...input(c), id }));
  setToday("2027-02-04");
  const next = await draft(
    c,
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 10_000_000 },
    { periodEnd: "2027-02-04", paymentDate: "2027-02-04" },
  );
  const after = await compute(c, next.id);
  eq("no blockers once cured", after.blockers.map((b) => b.code).join(","), "");
  const cLine = lineOf(after.lines, C.id);
  eq("C's line nets the interest", cLine?.defaultOffsetInterest, usd(187.4));
  eq("nothing is applied to Balance", cLine?.defaultOffsetBalance, 0n);
  eq("C is paid the rest", cLine?.net, (cLine?.gross ?? 0n) - usd(187.4));
  await inTx(finalize(c, next.id, after.hash));
  eq(
    "no offset receipt (interest only)",
    await db.capitalReceipt.count({
      where: { companyId: c.id, sourceType: "distribution" },
    }),
    0,
  );
  eq(
    "interest owed $0.00 after the distribution",
    (await view("2027-02-04")).interestOwed,
    0n,
  );
  await inTx(reverse(c, next.id));
  eq(
    "interest owed $187.40 again after the reverse",
    (await view("2027-02-04")).interestOwed,
    usd(187.4),
  );
}

void runScenarios([
  ["DR-1", dr1],
  ["finalize vs receipt", finalizeVsReceipt],
  ["offset run", offsetRun],
  ["excess held", excessHeld],
]);
