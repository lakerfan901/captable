/**
 * Integration checks for G16b unit transfers: `unitTransfer.complete` and
 * `unitTransfer.admit` (src/trpc/routers/unit-transfer-router), the transfer
 * fold-in of FOUNDATION `getMemberPositions` (src/server/llc/positions.ts)
 * and ECONOMICS `loadCompletedTransfers` / `applyUnitTransfer`
 * (src/server/llc/economics/transfers.ts), against the local database. Not
 * part of `vitest run`. Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=noreply@example.com \
 *   NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/transfers.integration.ts
 *
 * `unitTransfer.complete` and `admit` use the real calendar ("today" in the
 * company's time zone, not LLC_ECONOMICS_TODAY), so their scenarios use
 * effective dates around the real date (subscriptions in mid-October of the
 * current year's 2026 closing, transfer notices in October). The R39 worked
 * example T-1 (02-economics.md, effective 2027-06-01) is checked on a
 * COMPLETED row written directly, because no procedure can complete a
 * transfer effective in the future relative to a notice not yet received.
 *
 * Shelf life: the scenarios mix the real clock with fixed dates (October
 * 2026 subscriptions and notices, a distribution paid 2027-05-14). Written
 * for November 2026; from about 2027-05-01 the check "a finalized
 * distribution refuses a new transfer" no longer refuses (the new transfer's
 * effective date passes the payment date), and other dated checks drift.
 * Move the fixed dates before relying on a failure here as a regression.
 *
 * Companies are named `zz-g16b-…`, addresses are `@example.com`, and every
 * row is deleted at the end (harness.ts).
 */
import { randomUUID } from "node:crypto";
import { fromDateOnly } from "@/lib/date-only";
import { todayInZone } from "@/lib/governance/dates";
import { roundDiv } from "@/lib/llc/money";
import type { PositionsResult } from "@/lib/llc/positions";
import { buildSnapshotDraft } from "@/server/governance/snapshot";
import {
  createCommitment,
  decideCommitment,
  recordCapitalReceipt,
  reduceAcceptedCommitment,
  voidCapitalReceipt,
} from "@/server/llc/commitments";
import {
  computeDistribution,
  finalizeDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { getPositions } from "@/server/llc/economics/ledger";
import { getOrCreateLlcTerm } from "@/server/llc/economics/term";
import { getMemberPositions } from "@/server/llc/positions";
import { createCallerFactory } from "@/trpc/api/trpc";
import { unitTransferRouter } from "@/trpc/routers/unit-transfer-router/router";
import {
  actor,
  check,
  companyRef,
  createAdmin,
  createCompany,
  db,
  eq,
  expectRefused,
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
} from "./harness";

setCompanyPrefix("zz-g16b-");

const TODAY = todayInZone(new Date(), "America/Denver");
const SUBSCRIBED_ON = "2026-10-15";

/** Subscription signed, funded and accepted on `on` (before the transfers). */
function subscribeOn(
  c: TestCompany,
  stakeholderId: string,
  committedCents: bigint,
  paidCents: bigint,
  on = SUBSCRIBED_ON,
): Promise<string> {
  setToday(on);
  return inTx(async (tx) => {
    const commitment = await createCommitment(
      tx,
      {
        companyId: c.id,
        stakeholderId,
        unitClassId: c.preferredId,
        committedCents,
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
        amountCents: paidCents,
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
    return commitment.id;
  });
}

async function positionsOf(c: TestCompany, asOf?: string) {
  return await getMemberPositions(db, c.id, asOf === undefined ? {} : { asOf });
}

function row(
  rows: Awaited<ReturnType<typeof positionsOf>>,
  stakeholderId: string,
  unitClassId: string,
) {
  return rows.find(
    (r) => r.stakeholderId === stakeholderId && r.unitClassId === unitClassId,
  );
}

async function econ(c: TestCompany, asOf: string): Promise<PositionsResult> {
  return (await inTx((tx) => getPositions(tx, c.id, asOf))).positions;
}

const snapshot = (c: TestCompany, recordDate: string) =>
  inTx((tx) => buildSnapshotDraft(tx, c.id, recordDate));

/** Revenue and the minimum operating reserve, as distributions.integration.ts. */
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
        updatedById: "g16b-integration",
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
      createdById: "g16b-integration",
    },
  });
}

async function setBooksClosedThrough(c: TestCompany, date: string | null) {
  await inTx(async (tx) => {
    await getOrCreateLlcTerm(tx, c.id);
    await tx.llcTerm.update({
      where: { companyId: c.id },
      data: { booksClosedThrough: date === null ? null : fromDateOnly(date) },
    });
  });
}

// ---------------------------------------------------------------------------
// 1. R39 worked example T-1 (02-economics.md), both readers

async function workedExampleT1() {
  section("T-1: 40 of A's 100 units to N, effective 2027-06-01 (R39)");
  const c = await createCompany("t1");
  const A = await newMember(c, "A Holder");
  const N = await newMember(c, "N Transferee");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  setToday("2027-06-15");
  await db.unitTransfer.create({
    data: {
      publicId: `zz-g16b-${randomUUID().slice(0, 12)}`,
      companyId: c.id,
      kind: "PERMITTED_TRANSFEREE",
      status: "COMPLETED",
      fromStakeholderId: A.id,
      toStakeholderId: N.id,
      unitClassId: c.preferredId,
      unitClassKind: "PREFERRED",
      units: "40",
      noticeReceivedOn: fromDateOnly("2027-05-10"),
      transferNoticeOn: fromDateOnly("2027-05-10"),
      effectiveOn: fromDateOnly("2027-06-01"),
      rofrOutcome: "NOT_APPLICABLE",
      securitiesOpinion: "WAIVED",
      completedAt: new Date(),
      authorId: "g16b-integration",
    },
  });

  const before = await positionsOf(c, "2027-05-31");
  eq(
    "2027-05-31: A 100 units",
    row(before, A.id, c.preferredId)?.units,
    "100.000000",
  );
  eq("2027-05-31: N has no row", row(before, N.id, c.preferredId), undefined);
  const after = await positionsOf(c, "2027-06-01");
  eq(
    "2027-06-01: A 60 units",
    row(after, A.id, c.preferredId)?.units,
    "60.000000",
  );
  eq(
    "2027-06-01: A capital $60,000.00",
    row(after, A.id, c.preferredId)?.capitalCents,
    usd(60_000),
  );
  eq(
    "2027-06-01: A committed stays $100,000.00",
    row(after, A.id, c.preferredId)?.committedCents,
    usd(100_000),
  );
  eq(
    "2027-06-01: N 40 units",
    row(after, N.id, c.preferredId)?.units,
    "40.000000",
  );
  eq(
    "2027-06-01: N capital $40,000.00",
    row(after, N.id, c.preferredId)?.capitalCents,
    usd(40_000),
  );
  eq(
    "2027-06-01: N committed $0",
    row(after, N.id, c.preferredId)?.committedCents,
    0n,
  );

  const pre = await econ(c, "2027-05-31");
  eq("ECONOMICS 2027-05-31: N absent", pre.holders.get(N.id), undefined);
  const p = await econ(c, "2027-06-01");
  const a = p.holders.get(A.id);
  const n = p.holders.get(N.id);
  eq("T-1 A contributed $60,000.00", a?.contributed, usd(60_000));
  eq("T-1 A unreturned $60,000.00", a?.unreturned, usd(60_000));
  eq("T-1 A units 60", a?.preferredUnits, 60_000_000n);
  eq("T-1 A unpaid $2,590.69", a?.unpaidReturn, usd(2_590.69));
  eq("T-1 N contributed $40,000.00", n?.contributed, usd(40_000));
  eq("T-1 N unreturned $40,000.00", n?.unreturned, usd(40_000));
  eq("T-1 N units 40", n?.preferredUnits, 40_000_000n);
  eq("T-1 N unpaid $1,727.12 (carried)", n?.unpaidReturn, usd(1_727.12));
  eq("T-1 carry $1,727.12", n?.returnCarriedIn, usd(1_727.12));
}

// ---------------------------------------------------------------------------
// 2. complete / admit through the router, open-process refusals, a
//    distribution after the effective date

async function mainFlow() {
  const c = await createCompany("main");
  const carol = await newMember(c, "Carol Holder");
  const bob = await newMember(c, "Bob Holder");
  const dave = await newMember(c, "Dave Prospect");
  const carolCommitment = await subscribeOn(
    c,
    carol.id,
    usd(150_000),
    usd(150_000),
  );
  await subscribeOn(c, bob.id, usd(100_000), usd(50_000));
  setToday(TODAY);
  const admin = await createAdmin(c);
  const caller = createCallerFactory(unitTransferRouter)(admin.context);

  section("before any transfer");
  const snap0 = await snapshot(c, TODAY);
  eq(
    "register: 200 Preferred outstanding",
    snap0.preferredOutstanding,
    "200.000000",
  );

  const { publicId } = await caller.create({
    kind: "VOLUNTARY",
    fromStakeholderId: carol.id,
    toStakeholderId: dave.id,
    unitClassId: c.preferredId,
    units: "50",
    noticeReceivedOn: "2026-10-16",
  });

  section("complete on a fresh VOLUNTARY transfer");
  await expectRefused(
    "consent, ROFR, notice date and opinion together",
    () => caller.complete({ publicId }),
    new RegExp(
      [
        "^Enter the date the Manager received written notice of the transfer \\(Section 7\\.9\\.1\\)\\.",
        "The Manager's written consent is required \\(Section 7\\.1\\)\\.",
        "Record the outcome of the right of first refusal \\(Section 7\\.1\\)\\.",
        "Record the opinion of counsel or the Manager's waiver \\(Section 7\\.6\\)\\.$",
      ].join("\n"),
    ),
    "BAD_REQUEST",
  );

  await caller.update({
    publicId,
    managerConsent: "GRANTED",
    managerConsentOn: TODAY,
    rofrOutcome: "NOT_EXERCISED",
    rofrDecidedOn: TODAY,
    rofrNote: "Every holder of the right waived it in writing.",
    securitiesOpinion: "WAIVED",
    transferNoticeOn: "2026-10-20",
  });
  let t = await caller.get({ publicId });
  eq(
    "effectiveOn for a notice of 2026-10-20 is 2026-11-01",
    t.effectiveOn,
    "2026-11-01",
  );
  eq("no completion errors", t.completionErrors.length, 0);

  section("open processes are refused");
  await setBooksClosedThrough(c, "2026-11-01");
  await expectRefused(
    "closed books covering effectiveOn",
    () => caller.complete({ publicId }),
    /Books are closed through/,
    "BAD_REQUEST",
  );
  await setBooksClosedThrough(c, null);

  const fakeLine = await db.callNoticeLine.create({
    data: {
      companyId: c.id,
      callNoticeId: `zz-g16b-${randomUUID()}`,
      stakeholderId: carol.id,
      commitmentId: carolCommitment,
      amountCalledCents: usd(1_000),
      status: "SENT",
      sentOn: fromDateOnly("2026-10-20"),
      dueOn: fromDateOnly("2026-10-30"),
    },
  });
  await expectRefused(
    "transferor with an overdue Balance and no declared default",
    () => caller.complete({ publicId }),
    /^Carol Holder has an overdue Balance \(due 2026-10-30\) with no declared default\. Declare the default \(Section 4\.9\)/,
    "BAD_REQUEST",
  );
  const fakeDefault = await db.memberDefault.create({
    data: {
      companyId: c.id,
      callNoticeLineId: fakeLine.id,
      stakeholderId: carol.id,
      commitmentId: carolCommitment,
      dueOn: fromDateOnly("2026-10-30"),
      unpaidAtDueCents: usd(1_000),
      forfeitureDate: fromDateOnly("2026-11-06"),
      declaredById: "g16b-integration",
    },
  });
  await expectRefused(
    "transferor with an open default",
    () => caller.complete({ publicId }),
    /^Carol Holder is in default on the Balance due 2026-10-30 \(Section 4\.9\)\. Cure or void the default/,
    "BAD_REQUEST",
  );
  await db.memberDefault.update({
    where: { id: fakeDefault.id },
    data: { stakeholderId: dave.id, commitmentId: `zz-g16b-${randomUUID()}` },
  });
  await expectRefused(
    "transferee with an open default",
    () => caller.complete({ publicId }),
    /^Dave Prospect is in default on the Balance due 2026-10-30 \(Section 4\.9\)/,
    "BAD_REQUEST",
  );
  await db.memberDefault.delete({ where: { id: fakeDefault.id } });
  await db.callNoticeLine.delete({ where: { id: fakeLine.id } });

  const other = await createCompany("other");
  const otherCaller = createCallerFactory(unitTransferRouter)(
    (await createAdmin(other)).context,
  );
  await expectRefused(
    "another company cannot complete",
    () => otherCaller.complete({ publicId }),
    /^Transfer not found\.$/,
    "NOT_FOUND",
  );
  await expectRefused(
    "another company cannot admit",
    () => otherCaller.admit({ publicId, admittedOn: TODAY }),
    /^Transfer not found\.$/,
    "NOT_FOUND",
  );

  const sentResolution = await db.resolution.create({
    data: {
      publicId: `zz-g16b-${randomUUID().slice(0, 12)}`,
      companyId: c.id,
      type: "PURCHASE_ORDER",
      title: "Open consent",
      body: [],
      params: {},
      status: "SENT",
      recordDate: fromDateOnly(TODAY),
      authorId: admin.session.user.memberId as string,
    },
  });
  await expectRefused(
    "a SENT resolution with record date on or after effectiveOn",
    () => caller.complete({ publicId }),
    /^The resolution "Open consent" is out for consent with record date .* on or after this transfer's effective date 2026-11-01/,
    "BAD_REQUEST",
  );
  await db.resolution.update({
    where: { id: sentResolution.id },
    data: { recordDate: fromDateOnly("2026-10-31") },
  });

  section(
    "a DRAFT distribution after effectiveOn is allowed (finalize recomputes)",
  );
  await cashLedger(c, usd(100_000));
  setToday("2027-05-14");
  const draft = await inTx((tx) =>
    saveDistributionDraft(tx, {
      company: companyRef(c),
      actor,
      type: "OPERATING",
      periodStart: null,
      periodEnd: "2027-03-31",
      paymentDate: "2027-05-14",
      inputs: { type: "OPERATING" },
      notes: null,
    }),
  );
  const comp1 = await inTx((tx) =>
    computeDistribution(tx, companyRef(c), draft.id),
  );
  eq("draft has no blockers", comp1.blockers.map((b) => b.code).join(","), "");
  check(
    "draft pays no line to Dave yet",
    !comp1.lines.some((l) => l.stakeholderId === dave.id),
  );
  setToday(TODAY);

  section("complete");
  const auditsBefore = await db.audit.count({ where: { companyId: c.id } });
  const done = await caller.complete({ publicId });
  eq("returns effectiveOn", done.effectiveOn, "2026-11-01");
  eq(
    "returns transfereeStatus",
    done.transfereeStatus,
    "FINANCIAL_INTEREST_ONLY",
  );
  eq("returns admittedOn null", done.admittedOn, null);
  t = await caller.get({ publicId });
  eq("status COMPLETED", t.status, "COMPLETED");
  eq("stored effectiveOn", t.effectiveOn, "2026-11-01");
  check("completedAt set", t.completedAt !== null);
  const stored = await db.unitTransfer.findFirstOrThrow({
    where: { publicId },
  });
  eq(
    "completedById = member",
    stored.completedById,
    admin.session.user.memberId,
  );
  const daveNow = await db.stakeholder.findFirstOrThrow({
    where: { id: dave.id },
  });
  eq(
    "Dave is FINANCIAL_INTEREST_ONLY (R37)",
    daveNow.memberStatus,
    "FINANCIAL_INTEREST_ONLY",
  );
  eq(
    "deadlines: notice copy OPEN, the rest closed",
    t.deadlines
      .map((d) => `${d.ruleKey}:${d.status}`)
      .sort()
      .join(","),
    "TRANSFER_CLOSE_BY:NOT_APPLICABLE,TRANSFER_NOTICE_COPY:OPEN,TRANSFER_ROFR_MANAGER:DONE,TRANSFER_ROFR_MEMBERS:DONE",
  );
  eq(
    "close-by note",
    t.deadlines.find((d) => d.ruleKey === "TRANSFER_CLOSE_BY")?.note,
    "Transfer completed",
  );
  const audits = await db.audit.findMany({
    where: { companyId: c.id },
    select: { action: true },
  });
  eq("two audit rows written", audits.length - auditsBefore, 2);
  eq(
    "audit: stakeholder.updated and unitTransfer.completed",
    audits
      .filter((a) =>
        ["stakeholder.updated", "unitTransfer.completed"].includes(a.action),
      )
      .map((a) => a.action)
      .sort()
      .join(","),
    "stakeholder.updated,unitTransfer.completed",
  );
  await expectRefused(
    "complete twice",
    () => caller.complete({ publicId }),
    /^This transfer is closed\.$/,
    "BAD_REQUEST",
  );

  section("holdings: FOUNDATION fold-in");
  const p1031 = await positionsOf(c, "2026-10-31");
  eq(
    "2026-10-31 Carol 150",
    row(p1031, carol.id, c.preferredId)?.units,
    "150.000000",
  );
  eq("2026-10-31 Dave none", row(p1031, dave.id, c.preferredId), undefined);
  const p1101 = await positionsOf(c, "2026-11-01");
  const carol1101 = row(p1101, carol.id, c.preferredId);
  const dave1101 = row(p1101, dave.id, c.preferredId);
  eq("2026-11-01 Carol 100", carol1101?.units, "100.000000");
  eq(
    "2026-11-01 Carol capital $100,000.00",
    carol1101?.capitalCents,
    usd(100_000),
  );
  eq(
    "2026-11-01 Carol cash applied $100,000.00",
    carol1101?.cashAppliedCents,
    usd(100_000),
  );
  eq(
    "2026-11-01 Carol committed stays $150,000.00",
    carol1101?.committedCents,
    usd(150_000),
  );
  eq("2026-11-01 Dave 50", dave1101?.units, "50.000000");
  eq("2026-11-01 Dave capital $50,000.00", dave1101?.capitalCents, usd(50_000));
  eq("2026-11-01 Dave committed $0", dave1101?.committedCents, 0n);
  eq("2026-11-01 Dave outstanding $0", dave1101?.outstandingBalanceCents, 0n);
  eq(
    "2026-11-01 Bob unchanged 50",
    row(p1101, bob.id, c.preferredId)?.units,
    "50.000000",
  );
  const pNone = await positionsOf(c);
  eq(
    "no asOf (today): Dave 50",
    row(pNone, dave.id, c.preferredId)?.units,
    "50.000000",
  );
  const again = await positionsOf(c, TODAY);
  eq(
    "same result on every read",
    JSON.stringify(again, (_k, v) => (typeof v === "bigint" ? `${v}` : v)),
    JSON.stringify(await positionsOf(c, TODAY), (_k, v) =>
      typeof v === "bigint" ? `${v}` : v,
    ),
  );

  section("holdings: ECONOMICS (R39), cross-check passes");
  const e1031 = await econ(c, "2026-10-31");
  eq(
    "ECONOMICS 2026-10-31 Carol units 150",
    e1031.holders.get(carol.id)?.preferredUnits,
    150_000_000n,
  );
  const e1101 = await econ(c, "2026-11-01");
  const ec = e1101.holders.get(carol.id);
  const ed = e1101.holders.get(dave.id);
  // Carol: $150,000 from 2026-10-15, 17 days to 2026-11-01:
  // roundDiv(15,000,000 × 800 × 17, 3,650,000) = 55,890; carry = 1/3 = 18,630.
  eq("Carol contributed $100,000.00", ec?.contributed, usd(100_000));
  eq("Carol unreturned $100,000.00", ec?.unreturned, usd(100_000));
  eq("Dave contributed $50,000.00", ed?.contributed, usd(50_000));
  eq("Dave unreturned $50,000.00", ed?.unreturned, usd(50_000));
  eq("Dave units 50", ed?.preferredUnits, 50_000_000n);
  eq("carry to Dave $186.30", ed?.returnCarriedIn, 18_630n);
  eq("carried out of Carol $186.30", ec?.returnCarriedOut, 18_630n);
  eq("Carol unpaid after $372.60", ec?.unpaidReturn, 37_260n);
  eq("Dave unpaid $186.30", ed?.unpaidReturn, 18_630n);
  await econ(c, TODAY);
  check("ECONOMICS reads today without a ledger mismatch", true);

  section("vote register: Dave is Financial-Interest-only (R2)");
  const snapBefore = await snapshot(c, "2026-10-31");
  const carolBefore = snapBefore.entries.find(
    (e) => e.stakeholderId === carol.id,
  );
  eq(
    "record date 2026-10-31: Carol 150",
    carolBefore?.preferredUnits,
    "150.000000",
  );
  eq(
    "record date 2026-10-31: outstanding 200",
    snapBefore.preferredOutstanding,
    "200.000000",
  );
  const snapAfter = await snapshot(c, TODAY);
  const daveEntry = snapAfter.entries.find((e) => e.stakeholderId === dave.id);
  eq(
    "record date today: Dave 50 units",
    daveEntry?.preferredUnits,
    "50.000000",
  );
  eq("record date today: Dave is not a Member", daveEntry?.isMember, false);
  eq("record date today: issued 200", snapAfter.preferredIssued, "200.000000");
  eq(
    "record date today: outstanding 150 (Dave's 50 excluded)",
    snapAfter.preferredOutstanding,
    "150.000000",
  );

  section("the DRAFT distribution after effectiveOn now pays Dave");
  setToday("2027-05-14");
  await expectRefused(
    "finalize with the hash reviewed before the transfer",
    () =>
      inTx((tx) =>
        finalizeDistribution(tx, {
          company: companyRef(c),
          actor,
          id: draft.id,
          expectedHash: comp1.hash,
          solvencyConfirmed: true,
        }),
      ),
    /Figures changed since review/,
    "CONFLICT",
  );
  const comp2 = await inTx((tx) =>
    computeDistribution(tx, companyRef(c), draft.id),
  );
  const daveLine = comp2.lines.find((l) => l.stakeholderId === dave.id);
  check("recomputed draft has a line for Dave", daveLine !== undefined);
  check(
    "Dave's tier C > 0",
    (daveLine?.tierC ?? 0n) > 0n,
    `${daveLine?.tierC}`,
  );
  await inTx((tx) =>
    finalizeDistribution(tx, {
      company: companyRef(c),
      actor,
      id: draft.id,
      expectedHash: comp2.hash,
      solvencyConfirmed: true,
    }),
  );
  const paid = await db.distributionLine.findFirst({
    where: {
      companyId: c.id,
      distributionId: draft.id,
      stakeholderId: dave.id,
    },
  });
  check(
    "finalized distribution pays Dave (net > 0)",
    (paid?.netCents ?? 0n) > 0n,
    `${paid?.netCents}`,
  );
  setToday(TODAY);

  section(
    "a finalized distribution on or after effectiveOn refuses a new transfer",
  );
  const later = await caller.create({
    kind: "PERMITTED_TRANSFEREE",
    fromStakeholderId: bob.id,
    toStakeholderId: dave.id,
    unitClassId: c.preferredId,
    units: "10",
    noticeReceivedOn: TODAY,
  });
  await caller.update({
    publicId: later.publicId,
    securitiesOpinion: "RECEIVED",
    transferNoticeOn: TODAY,
  });
  await expectRefused(
    "finalized distribution paid 2027-05-14",
    () => caller.complete({ publicId: later.publicId }),
    /^Distribution No\. 1 was paid on .*Reverse it before recording anything dated on or before its payment date\./,
    "BAD_REQUEST",
  );
  eq(
    "refused transfer stays OPEN",
    (await caller.get({ publicId: later.publicId })).status,
    "OPEN",
  );

  section("admit");
  await expectRefused(
    "admit an OPEN transfer",
    () => caller.admit({ publicId: later.publicId, admittedOn: TODAY }),
    /^Only the transferee of a completed transfer can be admitted \(Section 7\.8\)\.$/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "admit without the checklist",
    () => caller.admit({ publicId, admittedOn: TODAY }),
    /^Exhibit B signature page not received \(7\.8\(a\)\)\.\nAdmission expenses not paid or waived \(7\.8\(b\)\)\.\nQualification not confirmed \(7\.8\(c\)\)\.\nManager consent to admission not recorded \(7\.8\(d\)\)\.$/,
    "BAD_REQUEST",
  );
  await caller.update({
    publicId,
    admissionSignaturePage: true,
    admissionExpensesPaid: true,
    admissionQualified: true,
    admissionManagerConsent: true,
  });
  await expectRefused(
    "admission date before effectiveOn",
    () => caller.admit({ publicId, admittedOn: "2026-10-31" }),
    /^The admission date cannot be before the transfer took effect \(2026-11-01, Section 7\.9\.1\)\.$/,
    "BAD_REQUEST",
  );
  await expectRefused(
    "admission date in the future",
    () => caller.admit({ publicId, admittedOn: "2099-01-01" }),
    /^The admission date cannot be in the future\.$/,
    "BAD_REQUEST",
  );
  const admitAuditFilter = {
    companyId: c.id,
    action: { in: ["unitTransfer.admitted", "stakeholder.admitted"] },
  };
  const admitAuditsBefore = await db.audit.count({ where: admitAuditFilter });
  const admitted = await caller.admit({ publicId, admittedOn: "2026-11-02" });
  eq("admit returns the date", admitted.admittedOn, "2026-11-02");
  const daveAdmitted = await db.stakeholder.findFirstOrThrow({
    where: { id: dave.id },
  });
  eq("Dave is a MEMBER", daveAdmitted.memberStatus, "MEMBER");
  eq(
    "Dave admittedOn 2026-11-02",
    daveAdmitted.admittedOn?.toISOString().slice(0, 10),
    "2026-11-02",
  );
  eq(
    "transfer admittedOn",
    (await caller.get({ publicId })).admittedOn,
    "2026-11-02",
  );
  const snapAdmitted = await snapshot(c, TODAY);
  eq(
    "after admit: Dave is a Member on the register",
    snapAdmitted.entries.find((e) => e.stakeholderId === dave.id)?.isMember,
    true,
  );
  eq(
    "after admit: outstanding 200",
    snapAdmitted.preferredOutstanding,
    "200.000000",
  );
  await expectRefused(
    "admit twice",
    () => caller.admit({ publicId, admittedOn: TODAY }),
    /^The transferee has already been admitted\.$/,
    "BAD_REQUEST",
  );
  const admitAudits = await db.audit.count({ where: admitAuditFilter });
  eq(
    "audit rows for admit (transfer + stakeholder)",
    admitAudits - admitAuditsBefore,
    2,
  );
}

// ---------------------------------------------------------------------------
// 3. Same-day chained transfers, transferee already a Member, a completion
//    that would break a later-effective transfer, Common Units

async function chainedFlow() {
  const c = await createCompany("chain");
  const bob = await newMember(c, "Bob Holder");
  const carol = await newMember(c, "Carol Member");
  const erin = await newMember(c, "Erin Prospect");
  const frank = await newMember(c, "Frank Prospect");
  const gina = await newMember(c, "Gina Prospect");
  const manager = await newMember(c, "Manager Common");
  await subscribeOn(c, bob.id, usd(50_000), usd(50_000));
  await subscribeOn(c, carol.id, usd(100_000), usd(100_000));
  await issueCommon(c, manager.id, "100", SUBSCRIBED_ON);
  setToday(TODAY);
  const admin = await createAdmin(c);
  const caller = createCallerFactory(unitTransferRouter)(admin.context);

  async function permitted(
    from: string,
    to: string,
    units: string,
    transferNoticeOn: string,
    kind: "PERMITTED_TRANSFEREE" | "DEATH_INCAPACITY" = "PERMITTED_TRANSFEREE",
    unitClassId = c.preferredId,
  ) {
    const { publicId } = await caller.create({
      kind,
      fromStakeholderId: from,
      toStakeholderId: to,
      unitClassId,
      units,
      noticeReceivedOn: "2026-10-16",
    });
    await caller.update({
      publicId,
      transferNoticeOn,
      ...(kind === "PERMITTED_TRANSFEREE"
        ? { securitiesOpinion: "RECEIVED" as const }
        : {}),
    });
    return publicId;
  }

  section(
    "same-day chain: Bob → Erin 20, then Erin → Frank 5, both effective 2026-11-01",
  );
  const x = await permitted(bob.id, erin.id, "20", "2026-10-20");
  await caller.complete({ publicId: x });
  const y = await permitted(
    erin.id,
    frank.id,
    "5",
    "2026-10-25",
    "DEATH_INCAPACITY",
  );
  await caller.complete({ publicId: y });
  const xRow = await db.unitTransfer.findFirstOrThrow({
    where: { publicId: x },
  });
  const yRow = await db.unitTransfer.findFirstOrThrow({
    where: { publicId: y },
  });
  eq(
    "both effective 2026-11-01",
    `${xRow.effectiveOn?.toISOString().slice(0, 10)},${yRow.effectiveOn?.toISOString().slice(0, 10)}`,
    "2026-11-01,2026-11-01",
  );
  check(
    "Bob → Erin completed first",
    (xRow.completedAt?.getTime() ?? 0) < (yRow.completedAt?.getTime() ?? 0),
  );
  // Make the creation order the opposite of the completion order: the old
  // ECONOMICS order (effectiveOn, createdAt) would now apply Erin → Frank
  // before Erin holds anything.
  await db.unitTransfer.update({
    where: { id: yRow.id },
    data: { createdAt: new Date(xRow.createdAt.getTime() - 60_000) },
  });
  for (const pass of [1, 2]) {
    const p = await positionsOf(c, TODAY);
    eq(
      `read ${pass}: Bob 30`,
      row(p, bob.id, c.preferredId)?.units,
      "30.000000",
    );
    eq(
      `read ${pass}: Erin 15 / $15,000.00`,
      `${row(p, erin.id, c.preferredId)?.units} ${row(p, erin.id, c.preferredId)?.capitalCents}`,
      `15.000000 ${usd(15_000)}`,
    );
    eq(
      `read ${pass}: Frank 5 / $5,000.00`,
      `${row(p, frank.id, c.preferredId)?.units} ${row(p, frank.id, c.preferredId)?.capitalCents}`,
      `5.000000 ${usd(5_000)}`,
    );
    const e = await econ(c, TODAY);
    eq(
      `read ${pass}: ECONOMICS Erin 15 units`,
      e.holders.get(erin.id)?.preferredUnits,
      15_000_000n,
    );
    eq(
      `read ${pass}: ECONOMICS Frank $5,000.00`,
      e.holders.get(frank.id)?.contributed,
      usd(5_000),
    );
  }
  const pBefore = await positionsOf(c, "2026-10-31");
  eq(
    "2026-10-31: Bob still 50",
    row(pBefore, bob.id, c.preferredId)?.units,
    "50.000000",
  );
  eq("2026-10-31: Erin none", row(pBefore, erin.id, c.preferredId), undefined);

  section("transferee already a Member");
  const toCarol = await permitted(bob.id, carol.id, "10", "2026-10-26");
  await expectRefused(
    "Member transferee without the admission checklist",
    () => caller.complete({ publicId: toCarol }),
    /^The transferee is already a Member: complete the admission checklist for these Units \(Section 7\.8\) before completing\.$/,
    "BAD_REQUEST",
  );
  await caller.update({
    publicId: toCarol,
    admissionSignaturePage: true,
    admissionExpensesPaid: true,
    admissionQualified: true,
  });
  const doneCarol = await caller.complete({ publicId: toCarol });
  eq(
    "Member transferee: transfereeStatus MEMBER",
    doneCarol.transfereeStatus,
    "MEMBER",
  );
  eq(
    "Member transferee: transfer admittedOn today",
    (await caller.get({ publicId: toCarol })).admittedOn,
    TODAY,
  );
  eq(
    "Carol 110 units",
    row(await positionsOf(c, TODAY), carol.id, c.preferredId)?.units,
    "110.000000",
  );
  await expectRefused(
    "admit after completion to a Member",
    () => caller.admit({ publicId: toCarol, admittedOn: TODAY }),
    /^The transferee has already been admitted\.$/,
    "BAD_REQUEST",
  );

  section("units as of effectiveOn");
  const tooEarly = await permitted(carol.id, gina.id, "1", "2026-09-20");
  await expectRefused(
    "transferor held nothing on 2026-10-01",
    () => caller.complete({ publicId: tooEarly }),
    /^The transferor holds only 0 units\.$/,
    "BAD_REQUEST",
  );

  section(
    "a completion that would break a later-effective completed transfer is rolled back",
  );
  const z1 = await permitted(
    erin.id,
    frank.id,
    "15",
    TODAY,
    "DEATH_INCAPACITY",
  );
  await caller.complete({ publicId: z1 }); // effective the 1st of next month
  const z2 = await permitted(
    erin.id,
    gina.id,
    "15",
    "2026-10-27",
    "DEATH_INCAPACITY",
  );
  await expectRefused(
    "Erin → Gina effective 2026-11-01 would leave Erin → Frank without units",
    () => caller.complete({ publicId: z2 }),
    /^Completing this transfer would leave Erin Prospect without the 15 units already transferred to Frank Prospect effective \d{4}-\d{2}-01 \(Section 7\.9\.1\)\.$/,
    "BAD_REQUEST",
  );
  eq(
    "Erin → Gina stays OPEN",
    (await caller.get({ publicId: z2 })).status,
    "OPEN",
  );
  eq(
    "Gina stays PROSPECT (rolled back)",
    (await db.stakeholder.findFirstOrThrow({ where: { id: gina.id } }))
      .memberStatus,
    "PROSPECT",
  );

  section("Common Units (exempt under 7.1)");
  const common = await permitted(
    manager.id,
    gina.id,
    "40",
    "2026-10-20",
    "PERMITTED_TRANSFEREE",
    c.commonId,
  );
  await expectRefused(
    "Common transfer without approval or exemption",
    () => caller.complete({ publicId: common }),
    /^A transfer of Common Units requires the approval of a Preferred Supermajority \(Section 7\.1\)\.$/,
    "BAD_REQUEST",
  );
  await caller.update({
    publicId: common,
    exemptUnder71: true,
    exemptNote: "To a controlled Affiliate.",
  });
  await caller.complete({ publicId: common });
  const pc = await positionsOf(c, TODAY);
  eq("Manager 60 Common", row(pc, manager.id, c.commonId)?.units, "60.000000");
  eq("Gina 40 Common", row(pc, gina.id, c.commonId)?.units, "40.000000");
  eq("Gina no Preferred row", row(pc, gina.id, c.preferredId), undefined);
  await econ(c, TODAY);
  check("ECONOMICS still reads after a Common transfer", true);
}

// ---------------------------------------------------------------------------
// 4. Odd amounts, receipts on and after the effective date, a second
//    transfer by the same holder: both readers agree (getPositions throws on
//    any difference)

async function receiptsAroundTransfers() {
  const c = await createCompany("odd");
  const holder = await newMember(c, "Hana Holder");
  const pat = await newMember(c, "Pat Prospect");
  const commitmentId = await subscribeOn(
    c,
    holder.id,
    usd(80_000),
    usd(33_333.33),
  );
  setToday(TODAY);
  const admin = await createAdmin(c);
  const caller = createCallerFactory(unitTransferRouter)(admin.context);

  async function deathTransfer(units: string, transferNoticeOn: string) {
    const { publicId } = await caller.create({
      kind: "DEATH_INCAPACITY",
      fromStakeholderId: holder.id,
      toStakeholderId: pat.id,
      unitClassId: c.preferredId,
      units,
      noticeReceivedOn: "2026-10-16",
    });
    await caller.update({ publicId, transferNoticeOn });
    return await caller.complete({ publicId });
  }

  section("11.111111 of 33.33333 units effective 2026-11-01");
  await deathTransfer("11.111111", "2026-10-20");
  // Recorded after the completion: one Balance receipt applied ON the
  // effective date, one after it.
  for (const [on, cents] of [
    ["2026-11-01", usd(12_345.67)],
    ["2026-11-10", usd(20_000.01)],
  ] as const) {
    await inTx((tx) =>
      recordCapitalReceipt(
        tx,
        { companyId: c.id, commitmentId, receivedOn: on, amountCents: cents },
        actor,
      ),
    );
  }
  const moved = roundDiv(usd(33_333.33) * 11_111_111n, 33_333_330n);
  const p = await positionsOf(c, TODAY);
  eq(
    "Pat capital = roundDiv(3,333,333 × 11.111111 / 33.33333)",
    row(p, pat.id, c.preferredId)?.capitalCents,
    moved,
  );
  eq("Pat units 11.111111", row(p, pat.id, c.preferredId)?.units, "11.111111");
  eq(
    "Hana keeps the later receipts",
    row(p, holder.id, c.preferredId)?.capitalCents,
    usd(33_333.33) + usd(12_345.67) + usd(20_000.01) - moved,
  );
  eq(
    "Hana outstanding Balance unchanged by the transfer",
    row(p, holder.id, c.preferredId)?.outstandingBalanceCents,
    usd(80_000) - usd(33_333.33) - usd(12_345.67) - usd(20_000.01),
  );
  for (const asOf of ["2026-10-31", "2026-11-01", TODAY]) {
    const e = await econ(c, asOf);
    check(
      `ECONOMICS agrees with FOUNDATION on ${asOf}`,
      e.holders.has(holder.id),
    );
  }

  section(
    "a second transfer by the same holder, effective the 1st of next month",
  );
  const second = await deathTransfer("7.777777", TODAY);
  const p2 = await positionsOf(c, second.effectiveOn);
  eq("Pat 18.888888 units", row(p2, pat.id, c.preferredId)?.units, "18.888888");
  const e2 = await econ(c, second.effectiveOn);
  eq(
    "ECONOMICS Pat units 18.888888",
    e2.holders.get(pat.id)?.preferredUnits,
    18_888_888n,
  );
  eq(
    "ECONOMICS Pat contributed = FOUNDATION capital",
    e2.holders.get(pat.id)?.contributed,
    row(p2, pat.id, c.preferredId)?.capitalCents,
  );
}

// ---------------------------------------------------------------------------
// 5. Ledger writes after a completion cannot strand it (guardCompletedTransfers)

async function strandingGuard() {
  const c = await createCompany("strand");
  const carol = await newMember(c, "Carol Holder");
  const bob = await newMember(c, "Bob Holder");
  const dave = await newMember(c, "Dave Prospect");
  const carolCommitment = await subscribeOn(
    c,
    carol.id,
    usd(200_000),
    usd(100_000),
  );
  const bobCommitment = await subscribeOn(c, bob.id, usd(100_000), usd(50_000));
  setToday(TODAY);
  const receipt = (commitmentId: string, on: string, cents: bigint) =>
    inTx((tx) =>
      recordCapitalReceipt(
        tx,
        { companyId: c.id, commitmentId, receivedOn: on, amountCents: cents },
        actor,
      ),
    );
  const carolBalance = await receipt(
    carolCommitment,
    "2026-11-11",
    usd(50_000),
  );
  const bobBalance = await receipt(bobCommitment, "2026-11-11", usd(10_000));
  const admin = await createAdmin(c);
  const caller = createCallerFactory(unitTransferRouter)(admin.context);
  const { publicId } = await caller.create({
    kind: "DEATH_INCAPACITY",
    fromStakeholderId: carol.id,
    toStakeholderId: dave.id,
    unitClassId: c.preferredId,
    units: "120",
    noticeReceivedOn: "2026-10-16",
  });
  await caller.update({ publicId, transferNoticeOn: TODAY });
  const { effectiveOn } = await caller.complete({ publicId });
  section(`120 of Carol's 150 units to Dave, effective ${effectiveOn}`);
  const stranded = new RegExp(
    `^This would leave Carol Holder without the 120 units transferred to Dave Prospect effective ${effectiveOn} \\(Section 7\\.9\\.1\\)\\.`,
  );

  await expectRefused(
    "void of Carol's $50,000 Balance receipt (dated before effectiveOn)",
    () =>
      inTx((tx) =>
        voidCapitalReceipt(
          tx,
          {
            companyId: c.id,
            receiptId: carolBalance.id,
            reason: "Wire was returned",
          },
          actor,
        ),
      ),
    stranded,
    "BAD_REQUEST",
  );
  const kept = await db.capitalReceipt.findFirstOrThrow({
    where: { id: carolBalance.id },
  });
  eq("refused void left the receipt in place", kept.voidedAt, null);

  await expectRefused(
    "forfeiture of $50,000 of Carol's capital dated before effectiveOn",
    () =>
      inTx((tx) =>
        recordCapitalReceipt(
          tx,
          {
            companyId: c.id,
            commitmentId: carolCommitment,
            receivedOn: TODAY,
            amountCents: 0n,
            sourceType: "memberDefault",
            sourceId: "zz-g16b-default",
            special: { kind: "FORFEITURE", appliedCents: -usd(50_000) },
          },
          actor,
        ),
      ),
    stranded,
    "BAD_REQUEST",
  );
  eq(
    "no forfeiture receipt left behind",
    await db.capitalReceipt.count({
      where: { companyId: c.id, kind: "FORFEITURE" },
    }),
    0,
  );

  await inTx((tx) =>
    reduceAcceptedCommitment(
      tx,
      {
        companyId: c.id,
        commitmentId: carolCommitment,
        reduceByCents: usd(20_000),
        reason: "Section 4.9(ii) replacement funding (integration)",
      },
      actor,
    ),
  );
  const afterReduce = row(
    await positionsOf(c, effectiveOn),
    carol.id,
    c.preferredId,
  );
  eq(
    "4.9(ii) reduction allowed: Carol committed $180,000.00",
    afterReduce?.committedCents,
    usd(180_000),
  );
  eq("reduction leaves Carol's units", afterReduce?.units, "30.000000");

  await inTx((tx) =>
    voidCapitalReceipt(
      tx,
      {
        companyId: c.id,
        receiptId: bobBalance.id,
        reason: "Wire was returned",
      },
      actor,
    ),
  );
  check("a void that touches no transfer is allowed", true);
  await receipt(carolCommitment, TODAY, usd(10_000));
  eq(
    "a further Balance payment by Carol before effectiveOn is allowed",
    row(await positionsOf(c, effectiveOn), carol.id, c.preferredId)?.units,
    "40.000000",
  );
  const e = await econ(c, effectiveOn);
  eq(
    "ECONOMICS reads: Dave 120 units",
    e.holders.get(dave.id)?.preferredUnits,
    120_000_000n,
  );
  eq(
    "ECONOMICS reads: Dave contributed $120,000.00",
    e.holders.get(dave.id)?.contributed,
    usd(120_000),
  );
}

await runScenarios([
  ["T-1 worked example", workedExampleT1],
  ["complete and admit", mainFlow],
  ["chained and edge cases", chainedFlow],
  ["receipts around transfers", receiptsAroundTransfers],
  ["ledger writes cannot strand a transfer", strandingGuard],
]);
