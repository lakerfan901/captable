/**
 * Integration checks for the E11 default workflow
 * (src/server/llc/economics/defaults.ts) against the local database. Not part
 * of `vitest run`. Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=manager@example.com \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/defaults.integration.ts
 *
 * The Call Notice is really sent, to the local mail catcher only. "Today" is
 * stepped with LLC_ECONOMICS_TODAY (02-economics.md E11 acceptance). Every
 * row created is deleted at the end (see harness.ts).
 */
import { formatCents } from "@/lib/money";
import {
  recordCapitalReceipt,
  voidCapitalReceipt,
} from "@/server/llc/commitments";
import {
  getCommitmentStates,
  getLineStates,
  recordCallNoticePayment,
} from "@/server/llc/economics/call-notices";
import { getComplianceDates } from "@/server/llc/economics/compliance-dates";
import {
  addDefaultCharge,
  confirmCredit,
  confirmCure,
  confirmForfeiture,
  declareDefault,
  getDefaultView,
  getOverdueUndeclared,
  previewDefaultPayment,
  recordDefaultFunding,
  recordDefaultPayment,
  voidDefault,
} from "@/server/llc/economics/defaults";
import {
  computeDistribution,
  finalizeDistribution,
  reverseDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { getPositions } from "@/server/llc/economics/ledger";
import { lockCompanyLedger } from "@/server/llc/economics/scope";
import { createCallerFactory } from "@/trpc/api/trpc";
import { memberDefaultRouter } from "@/trpc/routers/member-default/router";
import {
  actor,
  check,
  createAdmin,
  createCompany,
  db,
  eq,
  errorOf,
  expectRefused,
  inTx,
  newMember,
  race,
  runScenarios,
  section,
  sendCall,
  setToday,
  subscribe,
  type TestCompany,
} from "./harness";

const U = 1_000_000n; // micro-units per unit
const $ = (dollars: number) => BigInt(Math.round(dollars * 100));

const company = (c: TestCompany) => ({
  id: c.id,
  name: c.name,
  timezone: c.timezone,
});
const input = (c: TestCompany) => ({ company: company(c), actor });

async function holdings(c: TestCompany, asOf: string) {
  const { positions } = await inTx((tx) => getPositions(tx, c.id, asOf));
  return positions;
}

async function unitsOf(c: TestCompany, asOf: string, holderId: string) {
  return (await holdings(c, asOf)).holders.get(holderId)?.preferredUnits ?? 0n;
}

// ---------------------------------------------------------------------------
// E11 worked case (02-economics.md E11): C never pays its $60,000 call.

async function workedCase() {
  section("E11 worked case: setup (Scenario S holders A, B, C plus insider K)");
  const c = await createCompany("e11-worked");
  const A = await newMember(c, "A Holder");
  const K = await newMember(c, "K Insider", { isInsider: true });
  const B = await newMember(c, "B Holder");
  const C = await newMember(c, "C Defaulter");
  await subscribe(c, A.id, $(100_000), {
    cents: $(100_000),
    receivedOn: "2026-11-16",
  });
  await subscribe(c, K.id, $(50_000), {
    cents: $(50_000),
    receivedOn: "2026-11-20",
  });
  await subscribe(c, B.id, $(250_000), {
    cents: $(250_000),
    receivedOn: "2026-11-23",
  });
  const cCommitment = await subscribe(c, C.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-30",
  });
  const start = await holdings(c, "2026-11-30");
  eq("units A 100", start.holders.get(A.id)?.preferredUnits, 100n * U);
  eq("units K 50", start.holders.get(K.id)?.preferredUnits, 50n * U);
  eq("units B 250", start.holders.get(B.id)?.preferredUnits, 250n * U);
  eq("units C 40", start.holders.get(C.id)?.preferredUnits, 40n * U);

  section("Call Notice sent 2027-01-14, due 2027-01-20");
  const call = await sendCall(
    c,
    cCommitment,
    $(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  eq("send result ok", call.sent.results[0]?.ok, true);
  eq("due date 2027-01-20", call.sent.dueOn, "2027-01-20");
  eq("line SENT", call.line.status, "SENT");
  check("email logged", call.sent.results[0]?.emailLogId != null);

  section("2027-01-20: due today, not overdue");
  setToday("2027-01-20");
  eq(
    "no overdue line on the due date",
    (await inTx((tx) => getOverdueUndeclared(tx, c.id, "2027-01-20"))).length,
    0,
  );
  await expectRefused(
    "declare on the due date refused",
    () =>
      inTx((tx) =>
        declareDefault(tx, {
          ...input(c),
          callNoticeLineId: call.lineId,
          expectedUnpaidCents: $(60_000),
        }),
      ),
    /next day/,
    "BAD_REQUEST",
  );

  section("2027-01-21: overdue, declare (and a parallel second declare)");
  setToday("2027-01-21");
  const overdue = await inTx((tx) =>
    getOverdueUndeclared(tx, c.id, "2027-01-21"),
  );
  eq("one overdue line", overdue.length, 1);
  eq("unpaid at due $60,000.00", overdue[0]?.unpaidAtDue, $(60_000));
  eq("Forfeiture Date 2027-01-27", overdue[0]?.forfeitureDate, "2027-01-27");
  eq(
    "window opens 2027-01-21",
    overdue[0]?.replacementWindow.opensOn,
    "2027-01-21",
  );
  eq(
    "window closes 2027-06-30",
    overdue[0]?.replacementWindow.closesOn,
    "2027-06-30",
  );
  await expectRefused(
    "declare with a stale expected amount is CONFLICT",
    () =>
      inTx((tx) =>
        declareDefault(tx, {
          ...input(c),
          callNoticeLineId: call.lineId,
          expectedUnpaidCents: $(59_999.99),
        }),
      ),
    /now \$60,000\.00/,
    "CONFLICT",
  );
  const declare = (tx: Parameters<typeof declareDefault>[0]) =>
    declareDefault(tx, {
      ...input(c),
      callNoticeLineId: call.lineId,
      expectedUnpaidCents: $(60_000),
    });
  const dRace = await race(declare, declare);
  check("declare race: separate connections", dRace.pids[0] !== dRace.pids[1]);
  check("declare race: second waited for the first", dRace.secondWaited);
  check("declare race: first succeeded", dRace.first.ok);
  check(
    "declare race: second refused (already recorded)",
    !dRace.second.ok && /already been recorded/.test(dRace.second.message),
    dRace.second.ok ? "succeeded" : dRace.second.message,
  );
  eq(
    "exactly one MemberDefault for the line",
    await db.memberDefault.count({ where: { companyId: c.id } }),
    1,
  );
  const md = await db.memberDefault.findFirstOrThrow({
    where: { companyId: c.id },
  });
  eq("stored unpaidAtDue", md.unpaidAtDueCents, $(60_000));
  eq(
    "stored forfeitureDate",
    md.forfeitureDate.toISOString().slice(0, 10),
    "2027-01-27",
  );
  const v1 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-01-21"));
  eq("suspended from 2027-01-21", v1.suspendedToday, true);
  eq(
    "C still 40 units after declaring",
    await unitsOf(c, "2027-01-21", C.id),
    40n * U,
  );
  await expectRefused(
    "funding dated 2027-01-20 (before the window) refused",
    () =>
      inTx((tx) =>
        recordDefaultFunding(tx, {
          ...input(c),
          id: md.id,
          funderStakeholderId: A.id,
          amountCents: $(30_000),
          fundedOn: "2027-01-20",
        }),
      ),
    /from 2027-01-21/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "the Defaulting Member cannot fund itself",
    () =>
      inTx((tx) =>
        recordDefaultFunding(tx, {
          ...input(c),
          id: md.id,
          funderStakeholderId: C.id,
          amountCents: $(1_000),
          fundedOn: "2027-01-21",
        }),
      ),
    /own Replacement Funder/,
  );

  section("2027-01-25: A funds $30,000 as Replacement Funder");
  setToday("2027-01-25");
  const f1 = await inTx((tx) =>
    recordDefaultFunding(tx, {
      ...input(c),
      id: md.id,
      funderStakeholderId: A.id,
      amountCents: $(30_000),
      fundedOn: "2027-01-25",
      reference: "RF-A",
    }),
  );
  eq(
    "outstanding after A's funding $30,000.00",
    f1.outstandingBalance,
    $(30_000),
  );
  eq(
    "C accepted commitment reduced to $70,000.00",
    (await db.commitment.findFirstOrThrow({ where: { id: cCommitment } }))
      .acceptedCents,
    $(70_000),
  );
  eq(
    "A 130 units on 2027-01-25",
    await unitsOf(c, "2027-01-25", A.id),
    130n * U,
  );
  eq(
    "A 100 units on 2027-01-24",
    await unitsOf(c, "2027-01-24", A.id),
    100n * U,
  );

  section("2027-01-27: Forfeiture Date (a cure today is in time)");
  setToday("2027-01-27");
  const v2 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-01-27"));
  eq(
    "forfeiture not available on the Forfeiture Date",
    v2.forfeiture.available,
    false,
  );
  await expectRefused(
    "confirmForfeiture on 2027-01-27 refused",
    () =>
      inTx((tx) =>
        confirmForfeiture(tx, {
          ...input(c),
          id: md.id,
          expectedForfeitedCents: $(30_000),
          expectedUnitsAfter: 10n * U,
        }),
      ),
    /after the Forfeiture Date 2027-01-27/,
  );

  section("2027-01-28: forfeiture FF-1 (and a parallel second confirmation)");
  setToday("2027-01-28");
  const v3 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-01-28"));
  const p = v3.forfeiture.proposal;
  eq("forfeiture available", v3.forfeiture.available, true);
  eq("FF-1 unpaidAtForfeiture $60,000.00", p?.unpaidAtForfeiture, $(60_000));
  eq("FF-1 half $30,000.00", p?.halfOfUnpaid, $(30_000));
  eq("FF-1 cap $40,000.00", p?.capitalPaid, $(40_000));
  eq("FF-1 capBinding false", p?.capBinding, false);
  eq("FF-1 forfeited $30,000.00", p?.forfeited, $(30_000));
  eq("FF-1 extinguished $381.37", p?.extinguishedReturn, $(381.37));
  eq("FF-1 units before 40", p?.unitsBefore, 40n * U);
  eq("FF-1 units after 10", p?.unitsAfter, 10n * U);
  await expectRefused(
    "confirmForfeiture with a stale amount is CONFLICT",
    () =>
      inTx((tx) =>
        confirmForfeiture(tx, {
          ...input(c),
          id: md.id,
          expectedForfeitedCents: $(29_999),
          expectedUnitsAfter: 10n * U,
        }),
      ),
    /Forfeited Amount is now/,
    "CONFLICT",
  );
  const forfeit = (tx: Parameters<typeof confirmForfeiture>[0]) =>
    confirmForfeiture(tx, {
      ...input(c),
      id: md.id,
      expectedForfeitedCents: $(30_000),
      expectedUnitsAfter: 10n * U,
    });
  const fRace = await race(forfeit, forfeit);
  check("forfeiture race: second waited", fRace.secondWaited);
  check("forfeiture race: first succeeded", fRace.first.ok);
  check(
    "forfeiture race: second refused",
    !fRace.second.ok && /already confirmed/.test(fRace.second.message),
    fRace.second.ok ? "succeeded" : fRace.second.message,
  );
  eq(
    "exactly one FORFEITURE receipt",
    await db.capitalReceipt.count({
      where: { companyId: c.id, kind: "FORFEITURE", voidedAt: null },
    }),
    1,
  );
  const atFd = await holdings(c, "2027-01-27");
  const cAtFd = atFd.holders.get(C.id);
  eq("C 10 units from the Forfeiture Date", cAtFd?.preferredUnits, 10n * U);
  eq(
    "C contributed $10,000.00 from the Forfeiture Date",
    cAtFd?.contributed,
    $(10_000),
  );
  eq("C unreturned $10,000.00", cAtFd?.unreturned, $(10_000));
  eq("C unpaid return $508.49 − $381.37", cAtFd?.unpaidReturn, $(127.12));
  eq(
    "C 40 units the day before",
    await unitsOf(c, "2027-01-26", C.id),
    40n * U,
  );

  section("2027-02-01: K (insider) funds $15,000");
  setToday("2027-02-01");
  await inTx((tx) =>
    recordDefaultFunding(tx, {
      ...input(c),
      id: md.id,
      funderStakeholderId: K.id,
      amountCents: $(15_000),
      fundedOn: "2027-02-01",
    }),
  );
  eq(
    "C accepted commitment $55,000.00",
    (await db.commitment.findFirstOrThrow({ where: { id: cCommitment } }))
      .acceptedCents,
    $(55_000),
  );

  section("2027-02-18: before the Credit Date");
  setToday("2027-02-18");
  await expectRefused(
    "confirmCredit before 2027-02-19 refused",
    () =>
      inTx((tx) =>
        confirmCredit(tx, {
          ...input(c),
          id: md.id,
          expectedPoolACents: $(11_250),
          expectedPoolBCents: $(22_500),
        }),
      ),
    /Credit Date 2027-02-19/,
  );

  section("2027-02-19: Credit Date, CR-1, I-3");
  setToday("2027-02-19");
  const v4 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-02-19"));
  eq("Credit Date 2027-02-19", v4.credit.creditDate, "2027-02-19");
  eq("I-3 interest owed $256.44", v4.interestOwed, $(256.44));
  eq("outstanding Balance $15,000.00", v4.outstandingBalance, $(15_000));
  eq(
    "CR-1 fundedCounted $45,000.00",
    v4.credit.proposal?.fundedCounted,
    $(45_000),
  );
  eq("CR-1 pool A $11,250.00", v4.credit.proposal?.poolA, $(11_250));
  eq("CR-1 redirected $3,750.00", v4.credit.proposal?.redirected, $(3_750));
  eq("CR-1 pool B $22,500.00", v4.credit.proposal?.poolB, $(22_500));
  const credits = new Map(
    (v4.credit.proposal?.credits ?? []).map((x) => [
      `${x.holderId}:${x.clause}`,
      x,
    ]),
  );
  eq("A clause A $7,500.00", credits.get(`${A.id}:A`)?.amount, $(7_500));
  eq("A clause B $5,625.00", credits.get(`${A.id}:B`)?.amount, $(5_625));
  eq("B clause B $14,062.50", credits.get(`${B.id}:B`)?.amount, $(14_062.5));
  eq("K clause B $2,812.50", credits.get(`${K.id}:B`)?.amount, $(2_812.5));
  eq(
    "K has no clause A credit (insider redirect)",
    credits.has(`${K.id}:A`),
    false,
  );
  await inTx((tx) =>
    confirmCredit(tx, {
      ...input(c),
      id: md.id,
      expectedPoolACents: $(11_250),
      expectedPoolBCents: $(22_500),
      expectedCreditDate: "2027-02-19",
    }),
  );
  const afterCredit = await holdings(c, "2027-02-19");
  eq(
    "A 143.125 units",
    afterCredit.holders.get(A.id)?.preferredUnits,
    143_125_000n,
  );
  eq(
    "B 264.0625 units",
    afterCredit.holders.get(B.id)?.preferredUnits,
    264_062_500n,
  );
  eq(
    "K 67.8125 units",
    afterCredit.holders.get(K.id)?.preferredUnits,
    67_812_500n,
  );
  eq("C 10 units", afterCredit.holders.get(C.id)?.preferredUnits, 10n * U);
  eq("total 485 units", afterCredit.totals.preferredUnits, 485n * U);
  eq("total capital $485,000.00", afterCredit.totals.contributed, $(485_000));
  eq(
    "two Replacement Funder commitments (A $30,000, K $15,000)",
    (
      await db.commitment.findMany({
        where: { companyId: c.id, isReplacement: true },
        orderBy: { acceptedCents: "desc" },
      })
    )
      .map((x) => formatCents(x.acceptedCents))
      .join(","),
    "$30,000.00,$15,000.00",
  );
  const v5 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-02-19"));
  eq("CU-4 not cured", v5.cure.cured, false);
  eq("still suspended", v5.suspendedToday, true);
  await expectRefused(
    "funding dated 2027-07-01 (after the Replacement Funder outside date) refused",
    () =>
      inTx((tx) =>
        recordDefaultFunding(tx, {
          ...input(c),
          id: md.id,
          funderStakeholderId: B.id,
          amountCents: $(1_000),
          fundedOn: "2027-07-01",
        }),
      ),
    /on or before 2027-06-30/,
  );

  section("2027-02-22 / 02-25: costs, payment split, cure");
  setToday("2027-02-22");
  await inTx((tx) =>
    addDefaultCharge(tx, {
      ...input(c),
      id: md.id,
      incurredOn: "2027-02-20",
      amountCents: $(500),
      description: "Collection letter (integration)",
    }),
  );
  const preview1 = await inTx((tx) =>
    previewDefaultPayment(tx, c.id, {
      id: md.id,
      paidOn: "2027-02-22",
      amountCents: $(5_000),
    }),
  );
  eq("owed interest on 2027-02-22 $271.23", preview1.owed.interest, $(271.23));
  eq("owed costs $500.00", preview1.owed.costs, $(500));
  eq("split: $5,000 to Balance", preview1.toBalance, $(5_000));
  await expectRefused(
    "payment with a stale split is CONFLICT",
    () =>
      inTx((tx) =>
        recordDefaultPayment(tx, {
          ...input(c),
          id: md.id,
          paidOn: "2027-02-22",
          amountCents: $(5_000),
          expected: {
            toBalanceCents: $(4_000),
            toInterestCents: $(1_000),
            toCostsCents: 0n,
          },
        }),
      ),
    /would now be applied/,
    "CONFLICT",
  );
  const pay1 = await inTx((tx) =>
    recordDefaultPayment(tx, {
      ...input(c),
      id: md.id,
      paidOn: "2027-02-22",
      amountCents: $(5_000),
      expected: {
        toBalanceCents: $(5_000),
        toInterestCents: 0n,
        toCostsCents: 0n,
      },
    }),
  );
  check("Balance part recorded as a receipt", pay1.capitalReceiptId !== null);
  eq("outstanding $10,000.00", pay1.outstandingBalance, $(10_000));
  eq("C 15 units on 2027-02-22", await unitsOf(c, "2027-02-22", C.id), 15n * U);
  setToday("2027-02-25");
  await expectRefused(
    "paying more than owed refused",
    () =>
      inTx((tx) =>
        recordDefaultPayment(tx, {
          ...input(c),
          id: md.id,
          paidOn: "2027-02-25",
          amountCents: $(10_781.11),
          expected: {
            toBalanceCents: $(10_000),
            toInterestCents: $(281.1),
            toCostsCents: $(500.01),
          },
        }),
      ),
    /exceeds what is owed/,
  );
  const preview2 = await inTx((tx) =>
    previewDefaultPayment(tx, c.id, {
      id: md.id,
      paidOn: "2027-02-25",
      amountCents: $(10_781.1),
    }),
  );
  eq("interest owed on 2027-02-25 $281.10", preview2.owed.interest, $(281.1));
  const pay2 = await inTx((tx) =>
    recordDefaultPayment(tx, {
      ...input(c),
      id: md.id,
      paidOn: "2027-02-25",
      amountCents: $(10_781.1),
      expected: {
        toBalanceCents: $(10_000),
        toInterestCents: $(281.1),
        toCostsCents: $(500),
      },
    }),
  );
  eq("nothing outstanding", pay2.outstandingBalance, 0n);
  eq("cure available", pay2.cureAvailable, true);
  const line = await db.callNoticeLine.findFirstOrThrow({
    where: { id: call.lineId },
  });
  eq("line PAID", line.status, "PAID");
  const v6 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-02-25"));
  eq("cure PAID_IN_FULL", v6.cure.method, "PAID_IN_FULL");
  eq("cured on 2027-02-25", v6.cure.curedOn, "2027-02-25");
  await expectRefused(
    "confirmCure with a stale date is CONFLICT",
    () =>
      inTx((tx) =>
        confirmCure(tx, {
          ...input(c),
          id: md.id,
          expectedCuredOn: "2027-02-24",
        }),
      ),
    /cure date is now 2027-02-25/,
    "CONFLICT",
  );
  await inTx((tx) =>
    confirmCure(tx, { ...input(c), id: md.id, expectedCuredOn: "2027-02-25" }),
  );
  const v7 = await inTx((tx) => getDefaultView(tx, c.id, md.id, "2027-02-25"));
  eq("status CURED", v7.status, "CURED");
  eq("suspension ends on the cure date", v7.suspendedToday, false);
  const end = await holdings(c, "2027-02-25");
  eq(
    "C 25 units after paying the rest",
    end.holders.get(C.id)?.preferredUnits,
    25n * U,
  );
  eq("total 500 units", end.totals.preferredUnits, 500n * U);
  await expectRefused(
    "voiding a default with fundings refused",
    () =>
      inTx((tx) =>
        voidDefault(tx, {
          ...input(c),
          id: md.id,
          reason: "integration void attempt",
        }),
      ),
    /open default|cannot be voided/,
  );
  // The loader still loads and agrees with FOUNDATION (getPositions cross-checks).
  check(
    "ledger loads after the whole workflow",
    (await errorOf(() => holdings(c, "2027-03-31"))) === null,
  );

  await tenantIsolation(c, md.id, call.lineId, A.id);
  await ledgerLock(c);
}

// ---------------------------------------------------------------------------
// $0 forfeiture: the late Balance is paid in full before the Forfeiture Date,
// the interest is not.

async function zeroForfeiture() {
  section(
    "$0 forfeiture: Balance paid late, interest unpaid at the Forfeiture Date",
  );
  const c = await createCompany("e11-zero");
  const A = await newMember(c, "A Holder");
  const E = await newMember(c, "E Late Payer");
  await subscribe(c, A.id, $(100_000), {
    cents: $(100_000),
    receivedOn: "2026-11-16",
  });
  const eCommitment = await subscribe(c, E.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-30",
  });
  const call = await sendCall(
    c,
    eCommitment,
    $(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  setToday("2027-01-21");
  const feed = () =>
    inTx((tx) =>
      getComplianceDates(tx, c.id, { from: "2027-01-01", to: "2027-06-30" }),
    );
  const callDue = `CALL_NOTICE_DUE:${call.lineId}`;
  eq(
    "before the default the call's due date is in the compliance feed, overdue",
    (await feed()).find((x) => x.key === callDue)?.status,
    "OVERDUE",
  );
  const d = await inTx((tx) =>
    declareDefault(tx, {
      ...input(c),
      callNoticeLineId: call.lineId,
      expectedUnpaidCents: $(60_000),
    }),
  );
  const declaredFeed = await feed();
  check(
    "once declared the call's due date leaves the feed",
    !declaredFeed.some((x) => x.key === callDue),
  );
  check(
    "and the default's Forfeiture Date takes over",
    declaredFeed.some((x) => x.key === `FORFEITURE_DATE:${d.id}`),
  );
  setToday("2027-01-22");
  const pay = await inTx((tx) =>
    recordDefaultPayment(tx, {
      ...input(c),
      id: d.id,
      paidOn: "2027-01-22",
      amountCents: $(60_000),
      expected: {
        toBalanceCents: $(60_000),
        toInterestCents: 0n,
        toCostsCents: 0n,
      },
    }),
  );
  eq("Balance paid in full on 2027-01-22", pay.outstandingBalance, 0n);
  eq("not cured: interest unpaid", pay.cureAvailable, false);
  setToday("2027-01-28");
  const v = await inTx((tx) => getDefaultView(tx, c.id, d.id, "2027-01-28"));
  eq("interest owed $39.45", v.interestOwed, $(39.45));
  eq("forfeiture due", v.forfeiture.available, true);
  eq("$0 Forfeited Amount", v.forfeiture.proposal?.forfeited, 0n);
  eq("units unchanged (100)", v.forfeiture.proposal?.unitsAfter, 100n * U);
  await inTx((tx) =>
    recordDefaultPayment(tx, {
      ...input(c),
      id: d.id,
      paidOn: "2027-01-28",
      amountCents: $(39.45),
      expected: {
        toBalanceCents: 0n,
        toInterestCents: $(39.45),
        toCostsCents: 0n,
      },
    }),
  );
  await expectRefused(
    "cure before the (due) forfeiture is confirmed refused",
    () =>
      inTx((tx) =>
        confirmCure(tx, {
          ...input(c),
          id: d.id,
          expectedCuredOn: "2027-01-28",
        }),
      ),
    /confirm the forfeiture first/,
  );
  const f = await inTx((tx) =>
    confirmForfeiture(tx, {
      ...input(c),
      id: d.id,
      expectedForfeitedCents: 0n,
      expectedUnitsAfter: 100n * U,
    }),
  );
  eq("$0 forfeiture writes no receipt", f.forfeitureReceiptId, null);
  eq(
    "no FORFEITURE receipt",
    await db.capitalReceipt.count({
      where: { companyId: c.id, kind: "FORFEITURE" },
    }),
    0,
  );
  eq("E keeps 100 units", await unitsOf(c, "2027-01-28", E.id), 100n * U);
  await inTx((tx) =>
    confirmCure(tx, { ...input(c), id: d.id, expectedCuredOn: "2027-01-28" }),
  );
  setToday("2027-02-19");
  const credit = await inTx((tx) =>
    confirmCredit(tx, {
      ...input(c),
      id: d.id,
      expectedPoolACents: 0n,
      expectedPoolBCents: 0n,
    }),
  );
  eq("$0 credit on 2027-02-19", credit.creditDate, "2027-02-19");
  eq(
    "no CREDIT receipt",
    await db.capitalReceipt.count({
      where: { companyId: c.id, kind: "CREDIT" },
    }),
    0,
  );
  const end = await holdings(c, "2027-02-19");
  eq("A 100, E 100 units", end.totals.preferredUnits, 200n * U);
}

// ---------------------------------------------------------------------------
// B2: money received before the due date is applied before a default is judged.

async function declareAfterReconcile() {
  section("B2: declare first applies prepaid money (failed match after send)");
  const c = await createCompany("e11-reconcile");
  const A = await newMember(c, "A Holder");
  const P = await newMember(c, "P Prepaid");
  const Q = await newMember(c, "Q Paid On Commitments Page");
  await subscribe(c, A.id, $(100_000), {
    cents: $(100_000),
    receivedOn: "2026-11-16",
  });
  const pCommitment = await subscribe(c, P.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-30",
  });
  const qCommitment = await subscribe(c, Q.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-30",
  });
  // P prepays the whole Balance before any Call Notice (held as prepaid).
  setToday("2027-01-05");
  await inTx((tx) =>
    recordCallNoticePayment(tx, {
      ...input(c),
      commitmentId: pCommitment,
      receivedOn: "2027-01-05",
      amountCents: $(60_000),
    }),
  );
  const pCall = await sendCall(
    c,
    pCommitment,
    $(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  eq(
    "P's line is matched at send and PAID",
    pCall.sent.results[0]?.status,
    "PAID",
  );
  // Simulate the documented failure of step C2 (prepaid match after the
  // send): its transaction rolled back, so no PREPAID allocation exists, the
  // line is SENT and prepaidMatchedAt is null.
  await db.$executeRaw`DELETE FROM "CallNoticeAllocation" WHERE "callNoticeLineId" = ${pCall.lineId}`;
  await db.$executeRaw`UPDATE "CallNoticeLine" SET status = 'SENT', "paidInFullOn" = NULL, "prepaidMatchedAt" = NULL WHERE id = ${pCall.lineId}`;
  await db.$executeRaw`UPDATE "CallNotice" SET status = 'SENT' WHERE id = ${pCall.noticeId}`;
  // Q pays its call on time, but through the Commitments page (FOUNDATION's
  // recordReceipt): a BALANCE receipt that no line is matched to.
  const qCall = await sendCall(
    c,
    qCommitment,
    $(60_000),
    "2027-01-15",
    "2027-01-21",
  );
  setToday("2027-01-19");
  await inTx((tx) =>
    recordCapitalReceipt(
      tx,
      {
        companyId: c.id,
        commitmentId: qCommitment,
        receivedOn: "2027-01-19",
        amountCents: $(60_000),
      },
      actor,
    ),
  );

  setToday("2027-01-22");
  const admin = await createAdmin(c);
  const caller = createCallerFactory(memberDefaultRouter)(admin.context);
  const pDeclare = await errorOf(() =>
    caller.declare({
      callNoticeLineId: pCall.lineId,
      expectedUnpaidCents: 6_000_000,
    }),
  );
  check(
    "a member who prepaid in full cannot be declared in default",
    pDeclare !== null && /Nothing is outstanding/.test(pDeclare.message),
    pDeclare ? pDeclare.message : "declared",
  );
  const pLine = await db.callNoticeLine.findFirstOrThrow({
    where: { id: pCall.lineId },
  });
  eq(
    "the prepaid match is kept (line PAID) after the refused declare",
    pLine.status,
    "PAID",
  );
  check(
    "prepaidMatchedAt set by the declare's reconcile",
    pLine.prepaidMatchedAt !== null,
  );
  eq(
    "no default recorded for P",
    await db.memberDefault.count({
      where: { companyId: c.id, callNoticeLineId: pCall.lineId },
    }),
    0,
  );

  const qDeclare = await errorOf(() =>
    inTx((tx) =>
      declareDefault(tx, {
        ...input(c),
        callNoticeLineId: qCall.lineId,
        expectedUnpaidCents: $(60_000),
      }),
    ),
  );
  check(
    "a member whose Balance money is recorded but not matched cannot be declared",
    qDeclare !== null &&
      /not applied to any Call Notice line/.test(qDeclare.message),
    qDeclare ? qDeclare.message : "declared",
  );
  const [qState] = await inTx((tx) =>
    getCommitmentStates(tx, c.id, { commitmentIds: [qCommitment] }),
  );
  eq(
    "Q's money is still shown as unmatched",
    qState?.prepaidUnallocated,
    $(60_000),
  );
  const qLines = await inTx((tx) =>
    getLineStates(tx, c.id, "2027-01-22", { commitmentId: qCommitment }),
  );
  eq(
    "Q's line still outstanding (needs the Manager)",
    qLines[0]?.outstanding,
    $(60_000),
  );
}

// ---------------------------------------------------------------------------
// Balance money recorded on the Commitments page after the declaration (a
// FOUNDATION receipt no line is matched to), racing the forfeiture.

async function unappliedMoneyOnDefault() {
  section(
    "Commitments-page receipt on a declared default, racing confirmForfeiture",
  );
  const c = await createCompany("e11-unapplied");
  const A = await newMember(c, "A Holder");
  const C = await newMember(c, "C Defaulter");
  await subscribe(c, A.id, $(100_000), {
    cents: $(100_000),
    receivedOn: "2026-11-16",
  });
  const cCommitment = await subscribe(c, C.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-30",
  });
  const call = await sendCall(
    c,
    cCommitment,
    $(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  setToday("2027-01-21");
  const d = await inTx((tx) =>
    declareDefault(tx, {
      ...input(c),
      callNoticeLineId: call.lineId,
      expectedUnpaidCents: $(60_000),
    }),
  );
  setToday("2027-01-28");
  const v = await inTx((tx) => getDefaultView(tx, c.id, d.id, "2027-01-28"));
  eq(
    "proposal: Forfeited Amount $30,000.00",
    v.forfeiture.proposal?.forfeited,
    $(30_000),
  );
  const pageReceipt = (tx: Parameters<typeof recordCapitalReceipt>[0]) =>
    recordCapitalReceipt(
      tx,
      {
        companyId: c.id,
        commitmentId: cCommitment,
        receivedOn: "2027-01-26",
        amountCents: $(5_000),
      },
      actor,
    );
  const forfeit = (tx: Parameters<typeof confirmForfeiture>[0]) =>
    confirmForfeiture(tx, {
      ...input(c),
      id: d.id,
      expectedForfeitedCents: $(30_000),
      expectedUnitsAfter: 10n * U,
    });
  const r = await race(pageReceipt, forfeit);
  check(
    "receipt first: recorded",
    r.first.ok,
    r.first.ok ? "" : r.first.message,
  );
  check("receipt first: the forfeiture waited for it", r.secondWaited);
  check(
    "receipt first: the forfeiture is refused as a rule violation (not an internal error)",
    !r.second.ok && r.second.code === "BAD_REQUEST",
    r.second.ok ? "it was confirmed" : `${r.second.code}: ${r.second.message}`,
  );
  eq(
    "no FORFEITURE receipt",
    await db.capitalReceipt.count({
      where: { companyId: c.id, kind: "FORFEITURE" },
    }),
    0,
  );
  await expectRefused(
    "the forfeiture is refused while that money is not applied",
    () => inTx(forfeit),
    /not applied to any Call Notice line/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "a Replacement Funder funding is refused while that money is not applied",
    () =>
      inTx((tx) =>
        recordDefaultFunding(tx, {
          ...input(c),
          id: d.id,
          funderStakeholderId: A.id,
          amountCents: $(1_000),
          fundedOn: "2027-01-28",
        }),
      ),
    /not applied to any Call Notice line/,
    "BAD_REQUEST",
  );
  // The remedy the message gives: void it, record it on the default page.
  if (r.first.ok) {
    const receiptId = r.first.value.id;
    await inTx((tx) =>
      voidCapitalReceipt(
        tx,
        { companyId: c.id, receiptId, reason: "re-record on the default page" },
        actor,
      ),
    );
  }
  await inTx((tx) =>
    recordDefaultPayment(tx, {
      ...input(c),
      id: d.id,
      paidOn: "2027-01-26",
      amountCents: $(5_000),
      expected: {
        toBalanceCents: $(5_000),
        toInterestCents: 0n,
        toCostsCents: 0n,
      },
    }),
  );
  const v2 = await inTx((tx) => getDefaultView(tx, c.id, d.id, "2027-01-28"));
  eq(
    "unpaid at the Forfeiture Date now $55,000.00",
    v2.forfeiture.proposal?.unpaidAtForfeiture,
    $(55_000),
  );
  eq(
    "Forfeited Amount now $27,500.00",
    v2.forfeiture.proposal?.forfeited,
    $(27_500),
  );
  eq("units 45 → 17.5", v2.forfeiture.proposal?.unitsAfter, 17_500_000n);
  check(
    "the forfeiture is confirmed on the corrected figures",
    (await errorOf(() =>
      inTx((tx) =>
        confirmForfeiture(tx, {
          ...input(c),
          id: d.id,
          expectedForfeitedCents: $(27_500),
          expectedUnitsAfter: 17_500_000n,
        }),
      ),
    )) === null,
  );
}

// ---------------------------------------------------------------------------
// A distribution paid ON the Forfeiture Date (PENDING_DEFAULT_STEP blocks
// only when the Forfeiture Date is before the payment date).

async function forfeitureOnPaymentDate() {
  section(
    "Distribution paid on the Forfeiture Date, forfeiture confirmed the next day",
  );
  const c = await createCompany("e11-fd-payment");
  const A = await newMember(c, "A Holder");
  const C = await newMember(c, "C Defaulter");
  await subscribe(c, A.id, $(100_000), {
    cents: $(100_000),
    receivedOn: "2026-11-16",
  });
  const cCommitment = await subscribe(c, C.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-30",
  });
  const call = await sendCall(
    c,
    cCommitment,
    $(60_000),
    "2027-01-14",
    "2027-01-20",
  );
  setToday("2027-01-21");
  const d = await inTx((tx) =>
    declareDefault(tx, {
      ...input(c),
      callNoticeLineId: call.lineId,
      expectedUnpaidCents: $(60_000),
    }),
  );
  setToday("2027-01-27");
  const { id } = await inTx((tx) =>
    saveDistributionDraft(tx, {
      ...input(c),
      type: "RETURN_OF_UNUSED_CAPITAL",
      periodStart: null,
      periodEnd: "2027-01-27",
      paymentDate: "2027-01-27",
      inputs: { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 100_000 },
      notes: null,
    }),
  );
  const comp = await inTx((tx) => computeDistribution(tx, company(c), id));
  eq(
    "no blocker on the Forfeiture Date itself (plan: forfeitureDate < paymentDate)",
    comp.blockers.map((b) => b.code).join(","),
    "",
  );
  await inTx((tx) =>
    finalizeDistribution(tx, {
      ...input(c),
      id,
      expectedHash: comp.hash,
      solvencyConfirmed: true,
    }),
  );
  setToday("2027-01-28");
  const v = await inTx((tx) => getDefaultView(tx, c.id, d.id, "2027-01-28"));
  await expectRefused(
    "the forfeiture (effective on the payment date) is refused instead of silently changing the distribution",
    () =>
      inTx((tx) =>
        confirmForfeiture(tx, {
          ...input(c),
          id: d.id,
          expectedForfeitedCents: v.forfeiture.proposal?.forfeited ?? 0n,
          expectedUnitsAfter: v.forfeiture.proposal?.unitsAfter ?? 0n,
        }),
      ),
    /Distribution No\. 1 was paid on Jan 27, 2027, the same date/,
  );
  await inTx((tx) =>
    reverseDistribution(tx, {
      ...input(c),
      id,
      reason: "Re-run after the forfeiture",
    }),
  );
  const v2 = await inTx((tx) => getDefaultView(tx, c.id, d.id, "2027-01-28"));
  const after = await errorOf(() =>
    inTx((tx) =>
      confirmForfeiture(tx, {
        ...input(c),
        id: d.id,
        expectedForfeitedCents: v2.forfeiture.proposal?.forfeited ?? 0n,
        expectedUnitsAfter: v2.forfeiture.proposal?.unitsAfter ?? 0n,
      }),
    ),
  );
  check(
    "after reversing the distribution the forfeiture is confirmed",
    after === null,
    after?.message ?? "",
  );
}

// ---------------------------------------------------------------------------

async function tenantIsolation(
  c: TestCompany,
  defaultId: string,
  lineId: string,
  stakeholderId: string,
) {
  section("Tenant isolation: another company cannot touch these ids");
  const other = await createCompany("e11-other");
  const stranger = await newMember(other, "Stranger");
  const o = input(other);
  const today = "2027-02-25";
  setToday(today);
  const notFound = /not found/i;
  const cases: [string, () => Promise<unknown>][] = [
    [
      "getDefaultView",
      () => inTx((tx) => getDefaultView(tx, other.id, defaultId, today)),
    ],
    [
      "previewDefaultPayment",
      () =>
        inTx((tx) =>
          previewDefaultPayment(tx, other.id, {
            id: defaultId,
            paidOn: today,
            amountCents: 100n,
          }),
        ),
    ],
    [
      "declareDefault",
      () =>
        inTx((tx) =>
          declareDefault(tx, {
            ...o,
            callNoticeLineId: lineId,
            expectedUnpaidCents: 1n,
          }),
        ),
    ],
    [
      "voidDefault",
      () =>
        inTx((tx) =>
          voidDefault(tx, {
            ...o,
            id: defaultId,
            reason: "tenant isolation check",
          }),
        ),
    ],
    [
      "addDefaultCharge",
      () =>
        inTx((tx) =>
          addDefaultCharge(tx, {
            ...o,
            id: defaultId,
            incurredOn: today,
            amountCents: 100n,
            description: "x",
          }),
        ),
    ],
    [
      "recordDefaultFunding",
      () =>
        inTx((tx) =>
          recordDefaultFunding(tx, {
            ...o,
            id: defaultId,
            funderStakeholderId: stranger.id,
            amountCents: 100n,
            fundedOn: today,
          }),
        ),
    ],
    [
      "recordDefaultPayment",
      () =>
        inTx((tx) =>
          recordDefaultPayment(tx, {
            ...o,
            id: defaultId,
            paidOn: today,
            amountCents: 100n,
            expected: {
              toBalanceCents: 100n,
              toInterestCents: 0n,
              toCostsCents: 0n,
            },
          }),
        ),
    ],
    [
      "confirmForfeiture",
      () =>
        inTx((tx) =>
          confirmForfeiture(tx, {
            ...o,
            id: defaultId,
            expectedForfeitedCents: 0n,
            expectedUnitsAfter: 0n,
          }),
        ),
    ],
    [
      "confirmCredit",
      () =>
        inTx((tx) =>
          confirmCredit(tx, {
            ...o,
            id: defaultId,
            expectedPoolACents: 0n,
            expectedPoolBCents: 0n,
          }),
        ),
    ],
    [
      "confirmCure",
      () =>
        inTx((tx) =>
          confirmCure(tx, { ...o, id: defaultId, expectedCuredOn: today }),
        ),
    ],
    [
      "recordDefaultFunding with a funder of another company",
      () =>
        inTx((tx) =>
          recordDefaultFunding(tx, {
            ...input(c),
            id: defaultId,
            funderStakeholderId: stranger.id,
            amountCents: 100n,
            fundedOn: today,
          }),
        ),
    ],
  ];
  for (const [name, run] of cases) {
    await expectRefused(
      `${name} refuses a foreign id`,
      run,
      notFound,
      "NOT_FOUND",
    );
  }
  // The other company's stakeholder id did not leak a write anywhere.
  eq(
    "no row written for the other company",
    await db.memberDefault.count({ where: { companyId: other.id } }),
    0,
  );
  void stakeholderId;
}

async function ledgerLock(c: TestCompany) {
  section("lockCompanyLedger serialises (advisory lock)");
  const same = await race(
    (tx) => lockCompanyLedger(tx, c.id),
    (tx) => lockCompanyLedger(tx, c.id),
  );
  check(
    "same company: the second lock waits for the first commit",
    same.secondWaited,
  );
  check("same company: both then succeed", same.first.ok && same.second.ok);
  const other = await race(
    (tx) => lockCompanyLedger(tx, c.id),
    (tx) => lockCompanyLedger(tx, `${c.id}-other`),
  );
  check("another company: no wait", !other.secondWaited && other.second.ok);
}

// ---------------------------------------------------------------------------
// A Call Notice payment dated on the acceptance date is Balance money.

async function sameDayBalancePayment() {
  section("Call Notice payment dated on the acceptance date (Section 4.9)");
  const c = await createCompany("e9-same-day");
  const A = await newMember(c, "A Same Day");
  const B = await newMember(c, "B Wired Early");
  // A: accepted, called and paid all on 2026-11-16.
  const aCommitment = await subscribe(c, A.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-16",
  });
  const aCall = await sendCall(
    c,
    aCommitment,
    $(60_000),
    "2026-11-16",
    "2026-11-19",
  );
  const paid = await inTx((tx) =>
    recordCallNoticePayment(tx, {
      ...input(c),
      commitmentId: aCommitment,
      receivedOn: "2026-11-16",
      amountCents: $(60_000),
    }),
  );
  const receipt = await db.capitalReceipt.findFirstOrThrow({
    where: { id: paid.capitalReceiptId, companyId: c.id },
  });
  eq("the payment is a BALANCE receipt", receipt.kind, "BALANCE");
  eq("all of it is applied as capital", receipt.appliedCents, $(60_000));
  eq(
    "its Preferred Return starts on the line's due date (R29)",
    receipt.prefReturnStartDate?.toISOString().slice(0, 10),
    "2026-11-19",
  );
  check(
    "all of it is applied to the call line",
    paid.allocations.length === 1 &&
      paid.allocations[0]?.lineId === aCall.lineId &&
      paid.allocations[0]?.amount === $(60_000),
    `${paid.allocations.length} allocations`,
  );
  eq("nothing is left as prepaid", paid.prepaid, 0n);
  const [aLine] = await inTx((tx) =>
    getLineStates(tx, c.id, "2026-11-20", { commitmentId: aCommitment }),
  );
  eq("the line shows $60,000.00 received", aLine?.allocated, $(60_000));
  eq("the line is PAID", aLine?.status, "PAID");
  eq("nothing is outstanding on the line", aLine?.outstanding, 0n);
  check("the line is not overdue after its due date", aLine?.overdue === false);
  setToday("2026-11-20");
  await expectRefused(
    "the member cannot be declared in default for the paid call",
    () =>
      inTx((tx) =>
        declareDefault(tx, {
          ...input(c),
          callNoticeLineId: aCall.lineId,
          expectedUnpaidCents: $(60_000),
        }),
      ),
    /Nothing is outstanding/,
  );
  eq("A holds 100 units", await unitsOf(c, "2026-11-20", A.id), 100n * U);

  // B: $40,000 wired 2026-11-16, accepted 2026-11-17, called the same day.
  const bCommitment = await subscribe(c, B.id, $(100_000), {
    cents: $(40_000),
    receivedOn: "2026-11-16",
    acceptedOn: "2026-11-17",
  });
  const held = await db.capitalReceipt.findFirstOrThrow({
    where: { companyId: c.id, commitmentId: bCommitment },
  });
  eq("money wired before acceptance stays INITIAL", held.kind, "INITIAL");
  eq(
    "and earns the Preferred Return from the wire date",
    held.prefReturnStartDate?.toISOString().slice(0, 10),
    "2026-11-16",
  );
  const bCall = await sendCall(
    c,
    bCommitment,
    $(60_000),
    "2026-11-17",
    "2026-11-20",
  );
  await expectRefused(
    "a Call Notice payment dated before the acceptance date is refused, saying why",
    () =>
      inTx((tx) =>
        recordCallNoticePayment(tx, {
          ...input(c),
          commitmentId: bCommitment,
          receivedOn: "2026-11-16",
          amountCents: $(60_000),
        }),
      ),
    /before the acceptance date 2026-11-17, is part of the Initial Installment.*Commitments page/,
  );
  eq(
    "no receipt was written for the refused payment",
    await db.capitalReceipt.count({
      where: { companyId: c.id, commitmentId: bCommitment },
    }),
    1,
  );
  eq(
    "and no allocation",
    await db.callNoticeAllocation.count({
      where: { companyId: c.id, callNoticeLineId: bCall.lineId },
    }),
    0,
  );
  setToday("2026-11-17");
  const bPaid = await inTx((tx) =>
    recordCallNoticePayment(tx, {
      ...input(c),
      commitmentId: bCommitment,
      receivedOn: "2026-11-17",
      amountCents: $(60_000),
    }),
  );
  check(
    "B's payment on its acceptance date pays its line",
    bPaid.allocations.length === 1 &&
      bPaid.allocations[0]?.lineId === bCall.lineId,
    `${bPaid.allocations.length} allocations`,
  );
}

void runScenarios([
  ["E11 worked case", workedCase],
  ["$0 forfeiture", zeroForfeiture],
  ["B2 declare reconcile", declareAfterReconcile],
  ["Forfeiture Date = payment date", forfeitureOnPaymentDate],
  ["unapplied money on a declared default", unappliedMoneyOnDefault],
  ["same-day Balance payment", sameDayBalancePayment],
]);
