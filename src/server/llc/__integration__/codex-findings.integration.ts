/**
 * Regression checks for the seven findings of the independent (Codex) review
 * of the LLC code, against the local database. Not part of `vitest run`.
 * Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   NEXTAUTH_SECRET=test-secret-for-review-only \
 *   EMAIL_SERVER=smtp://localhost:1025 EMAIL_FROM=manager@example.com \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/codex-findings.integration.ts
 *
 * Every company is named `zz-fixcodex-…`, every address is `@example.com`,
 * mail goes to the local mail catcher only, and every row created is deleted
 * at the end (harness.ts `cleanup`).
 *
 * 1. Reversing a distribution that a later confirmed forfeiture was computed
 *    on, or whose payment date lies in closed books, is refused.
 * 2. Accepting held money (and issuing Common Units) dated on or before a
 *    finalized distribution's payment date is refused.
 * 3. Matching prepaid Balance money that would move Preferred Return accrual
 *    behind a finalized distribution is refused before the Call Notice email
 *    is sent, and skipped (not thrown) by a later reconcile.
 * 4. An organizational expense above the Section 6.21 cap needs an EFFECTIVE
 *    Preferred Supermajority resolution of the same company.
 * 5. The voting register snapshot serialises with admissions.
 * 7. A stale report-email job cannot undo a replaced link's email; a stale
 *    ballot-email claim is released without sending.
 * (6 is a unit test: src/lib/sensitive-redaction.test.ts.)
 */
import { createServer, type Socket } from "node:net";
import type { Job } from "pg-boss";
import { env } from "@/env";
import { reportEmailWorker } from "@/jobs/governance-report-email";
import { fromDateOnly } from "@/lib/date-only";
import { sendOnce } from "@/server/governance/events";
import { takeRecordSnapshot } from "@/server/governance/snapshot";
import {
  createCommitment,
  decideCommitment,
  issueCommonUnits,
  recordCapitalReceipt,
  setReceiptPrefReturnStart,
} from "@/server/llc/commitments";
import {
  reconcileCallNoticeLines,
  recordCallNoticePayment,
  saveCallNoticeDraft,
  sendCallNotice,
} from "@/server/llc/economics/call-notices";
import {
  confirmForfeiture,
  declareDefault,
  getDefaultView,
  reconcileBeforeDeclare,
} from "@/server/llc/economics/defaults";
import {
  computeDistribution,
  type DistributionInputs,
  finalizeDistribution,
  reverseDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import {
  assertResolutionAuthorizes,
  insertExpense,
} from "@/server/llc/economics/financials";
import { getPositions } from "@/server/llc/economics/ledger";
import {
  closeBooksThrough,
  getOrCreateLlcTerm,
} from "@/server/llc/economics/term";
import {
  actor,
  check,
  companyRef,
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
  setCompanyPrefix,
  setToday,
  subscribe,
  type TestCompany,
  type Tx,
  usd,
} from "./harness";

setCompanyPrefix("zz-fixcodex-");

const input = (c: TestCompany) => ({ company: companyRef(c), actor });

function draft(
  c: TestCompany,
  inputs: DistributionInputs,
  periodEnd: string,
  paymentDate: string,
) {
  return inTx((tx) =>
    saveDistributionDraft(tx, {
      ...input(c),
      type: inputs.type,
      periodStart: null,
      periodEnd,
      paymentDate,
      inputs,
      notes: null,
    }),
  );
}

/** Saves, computes and finalizes a return of unused capital. */
async function returnCapital(
  c: TestCompany,
  amountCents: number,
  periodEnd: string,
  paymentDate: string,
) {
  const { id } = await draft(
    c,
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents },
    periodEnd,
    paymentDate,
  );
  const comp = await inTx((tx) => computeDistribution(tx, companyRef(c), id));
  eq(
    `distribution paid ${paymentDate} computes without blockers`,
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
  return id;
}

const reverse = (c: TestCompany, id: string) => (tx: Tx) =>
  reverseDistribution(tx, {
    ...input(c),
    id,
    reason: "Codex finding regression check",
  });

/** A pending commitment with money held (not yet accepted). */
function pendingWithHeld(
  c: TestCompany,
  stakeholderId: string,
  cents: bigint,
  receivedOn: string,
) {
  setToday(receivedOn);
  return inTx(async (tx) => {
    const commitment = await createCommitment(
      tx,
      {
        companyId: c.id,
        stakeholderId,
        unitClassId: c.preferredId,
        committedCents: cents,
        signedOn: "2026-11-10",
      },
      actor,
    );
    await recordCapitalReceipt(
      tx,
      {
        companyId: c.id,
        commitmentId: commitment.id,
        receivedOn,
        amountCents: cents,
      },
      actor,
    );
    return commitment.id;
  });
}

const accept =
  (c: TestCompany, commitmentId: string, acceptedOn: string) => (tx: Tx) =>
    decideCommitment(
      tx,
      { companyId: c.id, commitmentId, decision: "ACCEPT", acceptedOn },
      actor,
    );

// ---------------------------------------------------------------------------
// Finding 1

async function finding1() {
  section(
    "F1: reversing a return of capital that a later confirmed forfeiture was computed on",
  );
  const c = await createCompany("f1");
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
  setToday("2026-12-15");
  const distributionId = await returnCapital(
    c,
    3_900_000,
    "2026-11-30",
    "2026-12-15",
  );
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
  setToday("2027-01-28");
  const view = await inTx((tx) => getDefaultView(tx, c.id, d.id, "2027-01-28"));
  const proposal = view.forfeiture.proposal;
  check("forfeiture proposal available", proposal !== null);
  if (!proposal) return;
  await inTx((tx) =>
    confirmForfeiture(tx, {
      ...input(c),
      id: d.id,
      expectedForfeitedCents: proposal.forfeited,
      expectedUnitsAfter: proposal.unitsAfter,
    }),
  );
  const stored = await db.memberDefault.findFirstOrThrow({
    where: { id: d.id, companyId: c.id },
  });

  await expectRefused(
    "reversal refused: the confirmed forfeiture was computed on positions after it",
    () => inTx(reverse(c, distributionId)),
    /forfeiture/i,
  );
  const row = await db.distribution.findFirstOrThrow({
    where: { id: distributionId, companyId: c.id },
  });
  eq("distribution still FINALIZED", row.status, "FINALIZED");
  const fd = view.forfeitureDate;
  const replay = (await inTx((tx) => getPositions(tx, c.id, fd))).positions
    .forfeitures;
  const entry = replay.find((f) => f.holderId === C.id && f.on === fd);
  eq(
    "ledger replay still gives the stored capital deduction",
    entry?.unreturnedDeducted,
    stored.unreturnedDeductedCents,
  );
  eq(
    "ledger replay still gives the stored extinguished return",
    entry?.extinguishedReturn,
    stored.extinguishedReturnCents,
  );
  // Adjacent: a receipt of the defaulter back-dated before the Forfeiture
  // Date would change the confirmed figures the same way.
  await expectRefused(
    "a receipt of the defaulter dated before the Forfeiture Date is refused",
    () =>
      inTx((tx) =>
        recordCapitalReceipt(
          tx,
          {
            companyId: c.id,
            commitmentId: cCommitment,
            receivedOn: "2027-01-10",
            amountCents: usd(1_000),
          },
          actor,
        ),
      ),
    /forfeiture of C Defaulter's default was confirmed/,
  );

  section("F1: reversal when the books are closed through the payment date");
  const c2 = await createCompany("f1-books");
  const H = await newMember(c2, "H Holder");
  await subscribe(c2, H.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  setToday("2026-12-15");
  const d2 = await returnCapital(c2, 1_000_000, "2026-11-30", "2026-12-15");
  // A quarterly report for Q4 2026 (or any later close) closes the books.
  await inTx((tx) => closeBooksThrough(tx, c2.id, "2026-12-31"));
  setToday("2027-01-20");
  await expectRefused(
    "reversal refused while the books are closed through the payment date",
    () => inTx(reverse(c2, d2)),
    /Books are closed through/,
  );
  await db.llcTerm.update({
    where: { companyId: c2.id },
    data: { booksClosedThrough: fromDateOnly("2026-11-30") },
  });
  // A Q4 report sent after the distribution shows it: refused even with the
  // books reopened (a sent report cannot change).
  const q4 = await sentReport(c2, "2026-10-01", "2026-12-31");
  await expectRefused(
    "reversal refused once a quarterly report covering it was sent",
    () => inTx(reverse(c2, d2)),
    /member report .* was sent after distribution No\. 1/,
  );
  await db.memberReport.delete({ where: { id: q4 } });
  const ok = await errorOf(() => inTx(reverse(c2, d2)));
  check(
    "after the books are reopened before the payment date the reversal goes through",
    ok === null,
    ok?.message ?? "",
  );

  section(
    "F1: an operating distribution and the quarterly report of its own period",
  );
  const c3 = await createCompany("f1-operating");
  const O = await newMember(c3, "O Holder");
  await subscribe(c3, O.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  for (const [month, receipts] of [
    ["2026-11-01", 0n],
    ["2026-12-01", usd(12_631.58)],
  ] as const) {
    await db.revenuePeriod.create({
      data: {
        companyId: c3.id,
        month: fromDateOnly(month),
        customerReceiptsCents: receipts,
        managementFeeBps: 500,
        managementFeeCents: (receipts * 500n + 5_000n) / 10_000n,
        updatedById: "codex-integration",
      },
    });
  }
  await db.reserveEntry.create({
    data: {
      companyId: c3.id,
      effectiveOn: fromDateOnly("2026-11-20"),
      kind: "MINIMUM_OPERATING",
      type: "ESTABLISH",
      amountCents: usd(50_000),
      fundingSource: "CAPITAL_CONTRIBUTIONS",
      reason: "Minimum operating reserve (codex integration)",
      createdById: "codex-integration",
    },
  });
  setToday("2027-01-10");
  const op = await draft(c3, { type: "OPERATING" }, "2026-12-31", "2027-01-10");
  const opComp = await inTx((tx) =>
    computeDistribution(tx, companyRef(c3), op.id),
  );
  eq(
    "operating distribution computes without blockers",
    opComp.blockers.map((b) => b.code).join(","),
    "",
  );
  await inTx((tx) =>
    finalizeDistribution(tx, {
      ...input(c3),
      id: op.id,
      expectedHash: opComp.hash,
      solvencyConfirmed: true,
    }),
  );
  // Its own close (books closed through its period end) does not block; the
  // Q4 report for that same period, sent afterwards, does.
  const ownClose = await sentReport(c3, "2026-10-01", "2026-12-31");
  setToday("2027-01-20");
  await expectRefused(
    "reversal refused: the report of its own period was sent after it",
    () => inTx(reverse(c3, op.id)),
    /member report .* was sent after distribution No\. 1/,
  );
  await db.memberReport.delete({ where: { id: ownClose } });
  const opOk = await errorOf(() => inTx(reverse(c3, op.id)));
  check(
    "without the report, the books closed only by the distribution itself do not block",
    opOk === null,
    opOk?.message ?? "",
  );
}

/** A SENT quarterly report of the period (fixture; sent now). */
async function sentReport(c: TestCompany, start: string, end: string) {
  const r = await db.memberReport.create({
    data: {
      publicId: `zz-fixcodex-q-${Math.random().toString(36).slice(2, 12)}`,
      companyId: c.id,
      type: "QUARTERLY",
      status: "SENT",
      title: `Report ${end}`,
      periodStart: fromDateOnly(start),
      periodEnd: fromDateOnly(end),
      authorId: "codex-integration",
      sentAt: new Date(),
    },
    select: { id: true },
  });
  return r.id;
}

// ---------------------------------------------------------------------------
// Finding 2

async function finding2() {
  section(
    "F2: held money accepted, or Common Units issued, behind a finalized distribution",
  );
  const c = await createCompany("f2");
  const A = await newMember(c, "A Holder");
  const B = await newMember(c, "B Prospect");
  const M = await newMember(c, "M Common");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  const bCommitment = await pendingWithHeld(c, B.id, usd(50_000), "2026-11-18");
  setToday("2026-11-20");
  await returnCapital(c, 1_000_000, "2026-11-20", "2026-11-20");
  const before = (await inTx((tx) => getPositions(tx, c.id, "2026-11-20")))
    .positions;
  await expectRefused(
    "accepting B's held $50,000 effective 2026-11-18 is refused",
    () => inTx(accept(c, bCommitment, "2026-11-18")),
    /Distribution No\. 1 was paid on/,
  );
  await expectRefused(
    "issuing Common Units dated 2026-11-19 is refused",
    () =>
      inTx((tx) =>
        issueCommonUnits(
          tx,
          {
            companyId: c.id,
            stakeholderId: M.id,
            units: "10",
            issuedOn: "2026-11-19",
          },
          actor,
        ),
      ),
    /Distribution No\. 1 was paid on/,
  );
  const after = (await inTx((tx) => getPositions(tx, c.id, "2026-11-20")))
    .positions;
  eq(
    "positions on the payment date unchanged",
    after.totals.preferredUnits,
    before.totals.preferredUnits,
  );
  setToday("2026-11-21");
  const ok = await errorOf(() => inTx(accept(c, bCommitment, "2026-11-21")));
  check(
    "accepting it effective after the payment date is allowed",
    ok === null,
    ok?.message ?? "",
  );
  const common = await errorOf(() =>
    inTx((tx) =>
      issueCommonUnits(
        tx,
        {
          companyId: c.id,
          stakeholderId: M.id,
          units: "10",
          issuedOn: "2026-11-21",
        },
        actor,
      ),
    ),
  );
  check(
    "issuing Common Units after the payment date is allowed",
    common === null,
    common?.message ?? "",
  );

  section("F2: the same writes inside closed books");
  const D = await newMember(c, "D Prospect");
  const dCommitment = await pendingWithHeld(c, D.id, usd(50_000), "2026-11-22");
  // A member report closed the books through 2026-11-26.
  await inTx((tx) => closeBooksThrough(tx, c.id, "2026-11-26"));
  setToday("2026-11-27");
  await expectRefused(
    "accepting held money effective inside the closed period is refused",
    () => inTx(accept(c, dCommitment, "2026-11-23")),
    /Books are closed through/,
  );
  await expectRefused(
    "issuing Common Units dated inside the closed period is refused",
    () =>
      inTx((tx) =>
        issueCommonUnits(
          tx,
          {
            companyId: c.id,
            stakeholderId: M.id,
            units: "5",
            issuedOn: "2026-11-24",
          },
          actor,
        ),
      ),
    /Books are closed through/,
  );
  const open = await errorOf(() => inTx(accept(c, dCommitment, "2026-11-27")));
  check(
    "accepting it effective after the closed period is allowed",
    open === null,
    open?.message ?? "",
  );
}

// ---------------------------------------------------------------------------
// Finding 3

async function finding3() {
  section(
    "F3: prepaid matching behind a finalized distribution (refused before the email)",
  );
  const c = await createCompany("f3");
  const A = await newMember(c, "A Holder");
  const aCommitment = await subscribe(c, A.id, usd(100_000), {
    cents: usd(40_000),
    receivedOn: "2026-11-16",
  });
  setToday("2026-11-17");
  const prepaid = await inTx((tx) =>
    recordCallNoticePayment(tx, {
      ...input(c),
      commitmentId: aCommitment,
      receivedOn: "2026-11-17",
      amountCents: usd(20_000),
    }),
  );
  setToday("2026-11-20");
  const distributionId = await returnCapital(
    c,
    100_000,
    "2026-11-20",
    "2026-11-30",
  );
  const frozen = await db.distributionLine.findFirstOrThrow({
    where: { companyId: c.id, distributionId, stakeholderId: A.id },
  });
  const notice = await inTx((tx) =>
    saveCallNoticeDraft(tx, {
      companyId: c.id,
      actor,
      purpose: "Codex F3",
      bankAccountId: c.bankAccountId,
      lines: [{ commitmentId: aCommitment, amountCalledCents: usd(20_000) }],
    }),
  );
  const emailsBefore = await db.emailLog.count({ where: { companyId: c.id } });
  await expectRefused(
    "sending the Call Notice (due 2026-11-25) is refused before any email",
    () =>
      sendCallNotice(db, {
        company: companyRef(c),
        actor,
        manager: { name: "Manager", email: "manager@example.com" },
        id: notice.id,
        expectedDueOn: "2026-11-25",
      }),
    /Distribution No\. 1/,
  );
  eq(
    "nothing was emailed",
    await db.emailLog.count({ where: { companyId: c.id } }),
    emailsBefore,
  );
  const line = await db.callNoticeLine.findFirstOrThrow({
    where: { companyId: c.id, callNoticeId: notice.id },
  });
  eq("the line is still UNSENT", line.status, "UNSENT");
  const atP = (await inTx((tx) => getPositions(tx, c.id, "2026-11-30")))
    .positions;
  eq(
    "replay on the payment date still gives the frozen unpaid return",
    atP.holders.get(A.id)?.unpaidReturn,
    frozen.unpaidReturnBeforeCents - frozen.tierCCents,
  );
  await expectRefused(
    "moving the prepaid receipt's Preferred Return start before the payment date directly is refused too",
    () =>
      inTx((tx) =>
        setReceiptPrefReturnStart(
          tx,
          {
            companyId: c.id,
            receiptId: prepaid.capitalReceiptId,
            startDate: "2026-11-25",
          },
          actor,
        ),
      ),
    /Distribution No\. 1 was paid on/,
  );

  section("F3: a later reconcile skips the match instead of throwing");
  // The state a send leaves when its email was accepted but the post-send
  // match did not run (crash between C1 and C2).
  await db.callNoticeLine.update({
    where: { id: line.id, companyId: c.id },
    data: {
      status: "SENT",
      sentAt: new Date("2026-11-20T15:00:00Z"),
      sentOn: fromDateOnly("2026-11-20"),
      dueOn: fromDateOnly("2026-11-25"),
      prepaidMatchedAt: null,
    },
  });
  await db.callNotice.update({
    where: { id: notice.id, companyId: c.id },
    data: { status: "SENT", sentAt: new Date("2026-11-20T15:00:00Z") },
  });
  const results = await inTx((tx) =>
    reconcileCallNoticeLines(tx, c.id, aCommitment, actor),
  );
  const r = results.find((x) => x.lineId === line.id);
  check(
    "reconcile reports the match as blocked by the distribution",
    r !== undefined &&
      r.matched === 0n &&
      /Distribution No\. 1/.test(r.blocked ?? ""),
    JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}` : v)),
  );
  const after = await db.callNoticeLine.findFirstOrThrow({
    where: { id: line.id, companyId: c.id },
  });
  check("prepaidMatchedAt stays null", after.prepaidMatchedAt === null);
  eq(
    "no allocation was written",
    await db.callNoticeAllocation.count({ where: { companyId: c.id } }),
    0,
  );
  setToday("2026-11-26");
  await inTx((tx) =>
    reconcileBeforeDeclare(tx, { ...input(c), callNoticeLineId: line.id }),
  );
  await expectRefused(
    "declaring the member in default is refused while the paid Balance is unapplied",
    () =>
      inTx((tx) =>
        declareDefault(tx, {
          ...input(c),
          callNoticeLineId: line.id,
          expectedUnpaidCents: usd(20_000),
        }),
      ),
    /not applied to any Call Notice line/,
  );
  // Dated after the payment date, so only the skipped match can refuse it.
  setToday("2026-12-01");
  await expectRefused(
    "a new payment is refused while earlier money cannot be matched",
    () =>
      inTx((tx) =>
        recordCallNoticePayment(tx, {
          ...input(c),
          commitmentId: aCommitment,
          receivedOn: "2026-12-01",
          amountCents: usd(1_000),
        }),
      ),
    /not yet matched to a Call Notice.*Distribution No\. 1/,
  );
  const second = await draft(
    c,
    { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 100_000 },
    "2026-11-30",
    "2026-12-01",
  );
  const comp = await inTx((tx) =>
    computeDistribution(tx, companyRef(c), second.id),
  );
  check(
    "a further distribution is blocked while a sent line is not matched",
    comp.blockers.some((b) => b.code === "UNMATCHED_PREPAID"),
    comp.blockers.map((b) => b.code).join(","),
  );
  await db.distribution.delete({ where: { id: second.id } });
  await inTx(reverse(c, distributionId));
  const rematch = await inTx((tx) =>
    reconcileCallNoticeLines(tx, c.id, aCommitment, actor),
  );
  const m = rematch.find((x) => x.lineId === line.id);
  check(
    "after the reversal the match goes through",
    m !== undefined && m.matched === usd(20_000) && m.status === "PAID",
    JSON.stringify(m, (_k, v) => (typeof v === "bigint" ? `${v}` : v)),
  );
}

// ---------------------------------------------------------------------------
// Finding 4

async function resolutionFixture(
  c: TestCompany,
  opts: {
    status: "DRAFT" | "SENT" | "EFFECTIVE";
    /** null: a Manager-approval-only resolution (e.g. a purchase order) */
    basis: "PREFERRED_SUPERMAJORITY" | "PREFERRED_MAJORITY" | null;
    effectiveAt: Date | null;
  },
) {
  const publicId = `zz-fixcodex-res-${Math.random().toString(36).slice(2, 12)}`;
  const r = await db.resolution.create({
    data: {
      publicId,
      companyId: c.id,
      type: "GENERAL_CONSENT",
      status: opts.status,
      title: "Codex F4 approval",
      matterKey: "ORG_EXPENSE_CAP",
      authorId: "codex-integration",
      effectiveAt: opts.effectiveAt,
    },
  });
  await db.resolutionRequirement.create({
    data: {
      resolutionId: r.id,
      companyId: c.id,
      position: 0,
      kind: opts.basis === null ? "MANAGER_APPROVAL" : "UNIT_VOTE",
      basis: opts.basis,
      section: "6.21",
    },
  });
  return r.id;
}

async function finding4() {
  section("F4: the Section 6.21 cap needs a real, effective resolution");
  const c = await createCompany("f4");
  const other = await createCompany("f4-other");
  const A = await newMember(c, "A Holder");
  await subscribe(c, A.id, usd(100_000), {
    cents: usd(100_000),
    receivedOn: "2026-11-16",
  });
  setToday("2026-12-01");
  const expense = (resolutionId: string | null, amountCents = 4_000_001n) =>
    inTx(async (tx) => {
      const term = await getOrCreateLlcTerm(tx, c.id);
      return insertExpense(tx, {
        companyId: c.id,
        term,
        today: "2026-12-01",
        createdById: "codex-integration",
        expense: {
          incurredOn: "2026-11-30",
          category: "ORGANIZATIONAL_OFFERING",
          payee: "Counsel",
          amountCents,
          memo: null,
          documentId: null,
          resolutionId,
          managerPaymentId: null,
        },
      });
    });
  // Below the cap a resolution is only a reference: any effective one of the
  // company (here Manager-approval-only, like a purchase order) is accepted.
  const po = await resolutionFixture(c, {
    status: "EFFECTIVE",
    basis: null,
    effectiveAt: new Date("2026-11-20T18:00:00Z"),
  });
  const under = await errorOf(() => expense(po, 10_000n));
  check(
    "below the cap, an effective Manager-approved resolution is accepted as a reference",
    under === null,
    under?.message ?? "",
  );
  await expectRefused(
    "below the cap, a made-up resolution id is still refused",
    () => expense("no-such-resolution", 10_000n),
    /not found in this company/,
  );
  await expectRefused(
    "$40,000.01 without a resolution is refused",
    () => expense(null),
    /Section 6\.21/,
  );
  await expectRefused(
    "$40,000.01 citing that Manager-approved resolution is refused (no Supermajority)",
    () => expense(po),
    /Preferred Supermajority/,
  );
  await expectRefused(
    "$40,000.01 with a made-up resolution id is refused",
    () => expense("no-such-resolution"),
    /resolution/i,
  );
  const foreign = await resolutionFixture(other, {
    status: "EFFECTIVE",
    basis: "PREFERRED_SUPERMAJORITY",
    effectiveAt: new Date("2026-11-20T12:00:00Z"),
  });
  await expectRefused(
    "another company's effective resolution is refused",
    () => expense(foreign),
    /resolution/i,
  );
  const draftRes = await resolutionFixture(c, {
    status: "SENT",
    basis: "PREFERRED_SUPERMAJORITY",
    effectiveAt: null,
  });
  await expectRefused(
    "a resolution still out for votes is refused",
    () => expense(draftRes),
    /not effective/i,
  );
  const majority = await resolutionFixture(c, {
    status: "EFFECTIVE",
    basis: "PREFERRED_MAJORITY",
    effectiveAt: new Date("2026-11-20T12:00:00Z"),
  });
  await expectRefused(
    "an effective Preferred Majority (not Supermajority) resolution is refused",
    () => expense(majority),
    /Supermajority/,
  );
  const late = await resolutionFixture(c, {
    status: "EFFECTIVE",
    basis: "PREFERRED_SUPERMAJORITY",
    effectiveAt: new Date("2026-12-01T18:00:00Z"),
  });
  await expectRefused(
    "a resolution that became effective after the expense date is refused",
    () => expense(late),
    /effective/i,
  );
  const good = await resolutionFixture(c, {
    status: "EFFECTIVE",
    basis: "PREFERRED_SUPERMAJORITY",
    effectiveAt: new Date("2026-11-20T18:00:00Z"),
  });
  const ok = await errorOf(() => expense(good));
  check(
    "an effective Preferred Supermajority resolution of the company is accepted",
    ok === null,
    ok?.message ?? "",
  );
  await expectRefused(
    "member loans: a made-up resolution id is refused",
    () =>
      inTx((tx) =>
        assertResolutionAuthorizes(tx, c.id, "no-such-resolution", {
          on: "2026-11-30",
          what: "this member loan",
          section: "4.6",
          requireSupermajority: true,
        }),
      ),
    /resolution/i,
  );
}

// ---------------------------------------------------------------------------
// Finding 5

/** `tx` whose `stakeholder.findMany` waits for `between()` after reading. */
function pauseAfterStakeholderRead(tx: Tx, between: () => Promise<void>): Tx {
  const stakeholder = new Proxy(tx.stakeholder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "findMany" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const rows = await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await between();
        return rows;
      };
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "stakeholder") return stakeholder;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function finding5() {
  section(
    "F5: the record snapshot and an admission committing between its reads",
  );
  const c = await createCompany("f5");
  const A = await newMember(c, "A Holder");
  const B = await newMember(c, "B Prospect");
  const C = await newMember(c, "C Prospect");
  await subscribe(c, A.id, usd(50_000), {
    cents: usd(50_000),
    receivedOn: "2026-11-16",
  });
  const bCommitment = await pendingWithHeld(c, B.id, usd(50_000), "2026-11-18");
  const cCommitment = await pendingWithHeld(c, C.id, usd(50_000), "2026-11-18");
  setToday("2026-11-18");

  let admitted: Promise<unknown> = Promise.resolve();
  const snapshot = await inTx((tx) =>
    takeRecordSnapshot(
      pauseAfterStakeholderRead(tx, async () => {
        // The admission runs in its own transaction while the snapshot sits
        // between its two reads; with the locks it waits for the snapshot.
        admitted = inTx(accept(c, bCommitment, "2026-11-18")).catch(
          (e: unknown) => e,
        );
        await Promise.race([admitted, new Promise((r) => setTimeout(r, 1500))]);
      }),
      {
        companyId: c.id,
        recordDate: "2026-11-18",
        purpose: "RESOLUTION",
        takenById: null,
      },
    ),
  );
  await admitted;
  const incoherent = snapshot.entries.filter(
    (e) =>
      e.memberStatus === "PROSPECT" &&
      (Number(e.preferredUnits) > 0 || Number(e.commonUnits) > 0),
  );
  check(
    "no snapshot entry holds units with the status read before the admission",
    incoherent.length === 0,
    incoherent
      .map((e) => `${e.name} ${e.memberStatus} ${e.preferredUnits}`)
      .join("; "),
  );
  const b = snapshot.entries.find((e) => e.stakeholderId === B.id);
  check(
    "B appears either not at all or as an admitted Member",
    b === undefined || b.memberStatus === "MEMBER",
    JSON.stringify(b),
  );
  const fresh = await db.stakeholder.findFirstOrThrow({
    where: { id: B.id, companyId: c.id },
  });
  eq("B was admitted afterwards", fresh.memberStatus, "MEMBER");

  section("F5: an admission holding its class lock delays the snapshot");
  const r = await race(accept(c, cCommitment, "2026-11-18"), (tx) =>
    takeRecordSnapshot(tx, {
      companyId: c.id,
      recordDate: "2026-11-18",
      purpose: "RESOLUTION",
      takenById: null,
    }),
  );
  check("admission succeeded", r.first.ok, r.first.ok ? "" : r.first.message);
  check("the snapshot waited for the admission", r.secondWaited);
  const entries = r.second.ok ? r.second.value.entries : [];
  const cEntry = entries.find((e) => e.stakeholderId === C.id);
  check(
    "the snapshot taken after it shows C admitted with its units",
    cEntry?.memberStatus === "MEMBER" && Number(cEntry.preferredUnits) === 50,
    JSON.stringify(cEntry),
  );
}

// ---------------------------------------------------------------------------
// Finding 7

/** An SMTP endpoint that accepts a connection and drops it when released. */
async function holdingSmtp() {
  const sockets: Socket[] = [];
  let connected: () => void = () => {};
  const firstConnection = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const server = createServer((socket) => {
    sockets.push(socket);
    connected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `smtp://127.0.0.1:${port}`,
    firstConnection,
    release: () => {
      for (const s of sockets) s.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const runReportJob = (recipientId: string, seq: number) =>
  reportEmailWorker.handler([
    { data: { recipientId, seq } } as unknown as Job<{
      recipientId: string;
      seq: number;
    }>,
  ]);

async function finding7() {
  section("F7: a stale failed report email and a replaced link");
  const c = await createCompany("f7");
  const H = await newMember(c, "H Holder");
  const report = await db.memberReport.create({
    data: {
      publicId: `zz-fixcodex-rep-${Math.random().toString(36).slice(2, 12)}`,
      companyId: c.id,
      type: "NOTICE",
      status: "SENT",
      title: "Codex F7 notice",
      authorId: "codex-integration",
      sentAt: new Date(),
      frozenContent: { title: "Codex F7 notice" },
    },
  });
  const recipient = await db.memberReportRecipient.create({
    data: {
      reportId: report.id,
      companyId: c.id,
      stakeholderId: H.id,
      name: "H Holder",
      email: H.email,
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const sentLogs = () =>
    db.emailLog.count({
      where: {
        companyId: c.id,
        relatedType: "memberReport",
        relatedId: report.id,
        status: "SENT",
      },
    });
  const state = () =>
    db.memberReportRecipient.findFirstOrThrow({
      where: { id: recipient.id, companyId: c.id },
    });

  const smtp = await holdingSmtp();
  const mailCatcher = env.EMAIL_SERVER;
  (env as { EMAIL_SERVER?: string }).EMAIL_SERVER = smtp.url;
  let staleError: unknown = null;
  let replacementSeq = -1;
  try {
    // The stale job claims seq 0 and is stuck in SMTP...
    const stale = runReportJob(recipient.id, 0).catch((e: unknown) => {
      staleError = e;
    });
    await smtp.firstConnection;
    eq("stale job claimed (sendCount 1)", (await state()).sendCount, 1);
    // ...while replaceLink bumps the version and reads the seq to emit.
    const bumped = await db.memberReportRecipient.update({
      where: { id: recipient.id, companyId: c.id, tokenVersion: 1 },
      data: { tokenVersion: 2, tokenRevokedAt: null },
      select: { sendCount: true },
    });
    replacementSeq = bumped.sendCount;
    // The stale job's send then fails.
    smtp.release();
    await stale;
  } finally {
    (env as { EMAIL_SERVER?: string }).EMAIL_SERVER = mailCatcher;
    await smtp.close();
  }
  check("the stale job failed", staleError !== null);
  eq(
    "the stale failure did not undo the newer request (sendCount stays 1)",
    (await state()).sendCount,
    1,
  );
  const logsBefore = await sentLogs();
  await runReportJob(recipient.id, replacementSeq);
  const afterReplacement = await state();
  eq(
    "the replacement job sent the new link (sendCount 2)",
    afterReplacement.sendCount,
    2,
  );
  eq("one email delivered", await sentLogs(), logsBefore + 1);
  // A retry of the stale job sends nothing.
  await runReportJob(recipient.id, 0);
  eq("a stale retry sends nothing", await sentLogs(), logsBefore + 1);
  // A failed send of the CURRENT version still releases its claim.
  (env as { EMAIL_SERVER?: string }).EMAIL_SERVER = "smtp://127.0.0.1:1";
  try {
    const failed = await errorOf(() => runReportJob(recipient.id, 2));
    check(
      "a current-version send failure throws (pg-boss retries)",
      failed !== null,
    );
  } finally {
    (env as { EMAIL_SERVER?: string }).EMAIL_SERVER = mailCatcher;
  }
  eq(
    "and releases its claim (sendCount back to 2)",
    (await state()).sendCount,
    2,
  );

  section("F7: a resend queued while an older send is in flight survives it");
  const smtp2 = await holdingSmtp();
  (env as { EMAIL_SERVER?: string }).EMAIL_SERVER = smtp2.url;
  let resendSeq = -1;
  try {
    const inFlight = runReportJob(recipient.id, 2).catch(() => undefined);
    await smtp2.firstConnection;
    // memberReport.resend reads the counter under the report lock: the
    // in-flight claim (3) is what it queues.
    resendSeq = (await state()).sendCount;
    smtp2.release();
    await inFlight;
  } finally {
    (env as { EMAIL_SERVER?: string }).EMAIL_SERVER = mailCatcher;
    await smtp2.close();
  }
  eq("the resend was queued at seq 3", resendSeq, 3);
  eq(
    "the failed in-flight send released its claim (sendCount 2)",
    (await state()).sendCount,
    2,
  );
  const beforeResend = await sentLogs();
  await runReportJob(recipient.id, resendSeq);
  eq(
    "the queued resend still claims and sends (sendCount 4)",
    (await state()).sendCount,
    4,
  );
  eq("its email was delivered", await sentLogs(), beforeResend + 1);

  section("F7: a ballot-email claim whose link changed is released unsent");
  const resolution = await db.resolution.create({
    data: {
      publicId: `zz-fixcodex-bal-${Math.random().toString(36).slice(2, 12)}`,
      companyId: c.id,
      type: "GENERAL_CONSENT",
      status: "SENT",
      title: "Codex F7 ballot",
      authorId: "codex-integration",
    },
  });
  let sends = 0;
  const claim = {
    resolutionId: resolution.id,
    companyId: c.id,
    type: "INVITE_EMAILED" as const,
    actorType: "system" as const,
    summary: "Invitation emailed (codex check)",
    dedupeKey: `codex-f7:${resolution.id}:v1`,
  };
  const send = () => {
    sends++;
    return Promise.resolve();
  };
  const stale = await sendOnce(claim, send, () => Promise.resolve(false));
  eq("a claim whose link is no longer current is SKIPPED", stale, "SKIPPED");
  eq("nothing was sent", sends, 0);
  eq(
    "its claim was released",
    await db.resolutionEvent.count({
      where: { resolutionId: resolution.id, dedupeKey: claim.dedupeKey },
    }),
    0,
  );
  const fresh = await sendOnce(claim, send, () => Promise.resolve(true));
  eq("a current claim sends", fresh, "SENT");
  eq("exactly one send", sends, 1);
}

await runScenarios([
  ["F1", finding1],
  ["F2", finding2],
  ["F3", finding3],
  ["F4", finding4],
  ["F5", finding5],
  ["F7", finding7],
]);
