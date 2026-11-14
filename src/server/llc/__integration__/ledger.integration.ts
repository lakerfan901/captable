/**
 * Integration checks for the F6 ledger services (src/server/llc/commitments.ts)
 * and the unit class router against a real database. Not part of `vitest run`
 * (it needs Postgres). Run from the repository root:
 *
 *   SKIP_ENV_VALIDATION=1 \
 *   DATABASE_URL=postgres://captable:password@localhost:54321/captable \
 *   node_modules/.bin/tsx \
 *     --import ./src/server/llc/__integration__/register.mjs \
 *     src/server/llc/__integration__/ledger.integration.ts
 *
 * It creates one throwaway LLC company (plus a user and team member for the
 * router calls), runs every scenario, checks the ledger invariant
 * (`ledgerInvariantErrors`) for every commitment after every mutation, and
 * deletes everything it created in a `finally`. It never migrates or resets
 * the database. Dates are fixed in early November 2026 and must not be after
 * the company's "today".
 */
import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { db, type PrismaTransactionalClient } from "@/server/db";
import * as ledger from "@/server/llc/commitments";
import {
  decideCommitment,
  issueCommonUnits,
  type LedgerActor,
  recordCapitalReceipt,
  recordRefund,
  reduceAcceptedCommitment,
  updatePendingCommitment,
  voidCapitalReceipt,
} from "@/server/llc/commitments";
import { getComplianceDates } from "@/server/llc/economics/compliance-dates";
import { ledgerInvariantErrors } from "@/server/llc/receipt-rules";
import { createCallerFactory } from "@/trpc/api/trpc";
import { stakeholderRouter } from "@/trpc/routers/stakeholder-router/router";
import { unitClassRouter } from "@/trpc/routers/unit-class-router/router";

type Tx = PrismaTransactionalClient;

const actor: LedgerActor = {
  userId: "ledger-integration",
  memberId: null,
  name: "Integration",
  requestIp: "127.0.0.1",
  userAgent: "ledger-integration",
};

const failures: string[] = [];
let checks = 0;

function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` (${detail})` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn);
}

/** Runs `fn`; returns the error message, or null when it succeeded. */
async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function expectRefused(
  label: string,
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  const message = await errorOf(fn);
  check(
    label,
    message !== null && pattern.test(message),
    message ?? "it succeeded",
  );
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

let companyId = "";
let preferredId = "";
let commonId = "";

/** Asserts the ledger invariant for every commitment of the company. */
async function assertInvariant(label: string): Promise<void> {
  const commitments = await db.commitment.findMany({
    where: { companyId },
    include: { receipts: { where: { voidedAt: null } } },
  });
  const errors = commitments.flatMap((c) =>
    ledgerInvariantErrors(
      c,
      c.receipts.map((r) => ({ ...r, unitsIssued: r.unitsIssued.toFixed(6) })),
    ).map((e) => `${c.id}: ${e}`),
  );
  check(`invariant after ${label}`, errors.length === 0, errors.join("; "));
}

function newMember(name: string, extra: object = {}) {
  return db.stakeholder.create({
    data: {
      companyId,
      name,
      email: `${randomUUID()}@ledger-integration.test`,
      ...extra,
    },
  });
}

function newCommitment(
  stakeholderId: string,
  committedCents: bigint,
  opts: { signedOn?: string; isReplacement?: boolean } = {},
) {
  return tx((t) =>
    ledger.createCommitment(
      t,
      {
        companyId,
        stakeholderId,
        unitClassId: preferredId,
        committedCents,
        signedOn: opts.signedOn ?? "2026-11-02",
        isReplacement: opts.isReplacement,
      },
      actor,
    ),
  );
}

function receive(commitmentId: string, receivedOn: string, cents: bigint) {
  return tx((t) =>
    recordCapitalReceipt(
      t,
      { companyId, commitmentId, receivedOn, amountCents: cents },
      actor,
    ),
  );
}

function accept(
  commitmentId: string,
  acceptedOn: string,
  extra: { acceptedCents?: bigint; keepCents?: bigint } = {},
) {
  return tx((t) =>
    decideCommitment(
      t,
      { companyId, commitmentId, decision: "ACCEPT", acceptedOn, ...extra },
      actor,
    ),
  );
}

function voidReceipt(receiptId: string) {
  return tx((t) =>
    voidCapitalReceipt(
      t,
      { companyId, receiptId, reason: "integration void" },
      actor,
    ),
  );
}

const receiptRow = (id: string) =>
  db.capitalReceipt.findFirstOrThrow({ where: { id } });
const commitmentRow = (id: string) =>
  db.commitment.findFirstOrThrow({ where: { id } });

// ---------------------------------------------------------------------------
// Scenarios

async function m2Race(caller: ReturnType<typeof makeCaller>) {
  console.log("M2 unit class update racing the first acceptance");
  const m = await newMember("M2 Race");
  const c = await newCommitment(m.id, 10_000_000n);
  await receive(c.id, "2026-11-03", 4_000_000n);
  const before = (await caller.list()).classes.find(
    (k) => k.id === preferredId,
  );
  if (!before) throw new Error("no preferred class");
  check("class not yet locked", before.termsLocked === false);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: () => void = () => {};
  const accepted = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const tx1 = db.$transaction(
    async (t) => {
      await decideCommitment(
        t,
        {
          companyId,
          commitmentId: c.id,
          decision: "ACCEPT",
          acceptedOn: "2026-11-05",
        },
        actor,
      );
      signal();
      await gate;
    },
    { timeout: 15_000 },
  );
  await accepted;
  const {
    kind: _k,
    issuedUnits: _i,
    termsLocked: _t,
    prefReturnDayCount: _d,
    ...terms
  } = before;
  const update = errorOf(() =>
    caller.update({ ...terms, prefReturnBps: 900, confirmAmendment: false }),
  );
  await new Promise((r) => setTimeout(r, 700));
  release();
  await tx1;
  const message = await update;
  const after = await db.unitClass.findFirstOrThrow({
    where: { id: preferredId },
  });
  check(
    "amendment-free change refused once the racing acceptance commits",
    message !== null &&
      /amendment/i.test(message) &&
      after.prefReturnBps === 800,
    message ?? `succeeded; prefReturnBps now ${after.prefReturnBps}`,
  );
  if (after.prefReturnBps !== 800) {
    await db.unitClass.update({
      where: { id: preferredId },
      data: { prefReturnBps: 800 },
    });
  }
}

async function m2Reductions(caller: ReturnType<typeof makeCaller>) {
  console.log("M2 cap below accepted total, authorized below issued");
  const classes = (await caller.list()).classes;
  const pref = classes.find((k) => k.id === preferredId);
  const common = classes.find((k) => k.id === commonId);
  if (!pref || !common) throw new Error("classes missing");
  const strip = <T extends Record<string, unknown>>(k: T) => {
    const {
      kind: _k,
      issuedUnits: _i,
      termsLocked: _t,
      prefReturnDayCount: _d,
      ...rest
    } = k;
    return rest;
  };
  const accepted = await db.commitment.aggregate({
    where: {
      companyId,
      unitClassId: preferredId,
      status: { in: ["ACCEPTED", "REDUCED"] },
    },
    _sum: { acceptedCents: true },
  });
  const total = Number(accepted._sum.acceptedCents ?? 0n);
  check("some capital accepted", total > 10_000_000);
  const newCap = 10_000_000; // = minimum, below the accepted total
  const message = await errorOf(() =>
    caller.update({
      ...(strip(pref) as typeof pref),
      offeringCapCents: newCap,
      confirmAmendment: true,
      amendmentReason: "integration amendment test",
    } as Parameters<typeof caller.update>[0]),
  );
  const after = await db.unitClass.findFirstOrThrow({
    where: { id: preferredId },
  });
  check(
    "offering cap below the accepted total refused",
    message !== null &&
      /cap/i.test(message) &&
      after.offeringCapCents !== 10_000_000n,
    message ?? "it succeeded",
  );
  if (after.offeringCapCents === 10_000_000n) {
    await db.unitClass.update({
      where: { id: preferredId },
      data: { offeringCapCents: 200_000_000n },
    });
  }
  const issued = Number(common.issuedUnits);
  check("some common units issued", issued >= 1);
  await expectRefused(
    "authorized common units below units issued refused",
    () =>
      caller.update({
        ...(strip(common) as typeof common),
        authorizedUnits: "0.5",
        confirmAmendment: true,
        amendmentReason: "integration amendment test",
      } as Parameters<typeof caller.update>[0]),
    /fewer units than are issued/i,
  );
}

async function h1Reduced() {
  console.log("H1 void and re-record on a reduced commitment");
  const m = await newMember("H1 Reduced");
  const c = await newCommitment(m.id, 20_000_000n);
  const r = await receive(c.id, "2026-11-03", 8_000_000n);
  await accept(c.id, "2026-11-05", { acceptedCents: 10_000_000n });
  const row = await receiptRow(r.id);
  const com = await commitmentRow(c.id);
  check(
    "default keep $40k, refund $40k",
    row.appliedCents === 4_000_000n && com.refundDueCents === 4_000_000n,
  );
  await assertInvariant("reduced acceptance");
  const voidError = await errorOf(() => voidReceipt(r.id));
  check(
    "void of the partly applied receipt refused",
    voidError !== null && /refund/i.test(voidError),
    voidError ?? "void succeeded",
  );
  await assertInvariant("void attempt");
  if (voidError === null) {
    const again = await receive(c.id, "2026-11-03", 8_000_000n);
    const againRow = await receiptRow(again.id);
    console.log(
      `       re-recorded receipt applied ${againRow.appliedCents}, refund due ${(await commitmentRow(c.id)).refundDueCents}`,
    );
    await assertInvariant("re-record");
  }
}

async function h1RejectedDuplicate() {
  console.log("H1 duplicate receipt voided on a rejected commitment");
  const m = await newMember("H1 Rejected");
  const c = await newCommitment(m.id, 10_000_000n);
  const r1 = await receive(c.id, "2026-11-03", 4_000_000n);
  const r2 = await receive(c.id, "2026-11-03", 4_000_000n);
  // Compliance calendar feed (Section 4.8): the decision is due while the
  // commitment is pending, the refund once it is decided, until it is paid.
  const feed = async () =>
    (
      await tx((t) =>
        getComplianceDates(t, companyId, {
          from: "2026-10-01",
          to: "2027-03-31",
        }),
      )
    ).filter((d) => d.sourceId === c.id);
  const pending = await feed();
  check(
    "pending: the acceptance deadline is in the compliance feed",
    pending.length === 1 &&
      pending[0]?.key === `ACCEPTANCE_DEADLINE:${c.id}` &&
      // 10 business days after 2026-11-03 (Veterans Day not counted)
      pending[0]?.dueOn === "2026-11-18",
    JSON.stringify(pending),
  );
  await tx((t) =>
    decideCommitment(
      t,
      {
        companyId,
        commitmentId: c.id,
        decision: "REJECT",
        acceptedOn: "2026-11-05",
        rejectionReason: "integration",
      },
      actor,
    ),
  );
  check(
    "refund due $80k",
    (await commitmentRow(c.id)).refundDueCents === 8_000_000n,
  );
  await assertInvariant("rejection");
  await voidReceipt(r2.id);
  check(
    "refund due $40k after the duplicate is voided",
    (await commitmentRow(c.id)).refundDueCents === 4_000_000n,
    String((await commitmentRow(c.id)).refundDueCents),
  );
  await assertInvariant("void of duplicate");
  const decided = await feed();
  check(
    "decided: the acceptance deadline left the feed, the $40,000.00 refund is due",
    decided.length === 1 &&
      decided[0]?.key === `REFUND_DUE:${c.id}` &&
      decided[0]?.label.startsWith("Refund $40,000.00 to H1 Rejected"),
    JSON.stringify(decided),
  );
  await tx((t) =>
    recordRefund(
      t,
      {
        companyId,
        commitmentId: c.id,
        paidCents: 4_000_000n,
        paidOn: "2026-11-06",
      },
      actor,
    ),
  );
  await assertInvariant("refund paid");
  check(
    "refunded: nothing for the commitment is left in the feed",
    (await feed()).length === 0,
  );
  await expectRefused(
    "void of a receipt whose refund was paid refused",
    () => voidReceipt(r1.id),
    /refund/i,
  );
  await assertInvariant("refused void");
}

async function h1ZeroAppliedDuplicate() {
  console.log("H1 zero-applied duplicate voided on a reduced commitment");
  const m = await newMember("H1 Zero");
  const c = await newCommitment(m.id, 20_000_000n);
  const r1 = await receive(c.id, "2026-11-03", 8_000_000n);
  const r2 = await receive(c.id, "2026-11-03", 8_000_000n);
  await accept(c.id, "2026-11-05", { acceptedCents: 10_000_000n });
  const [a, b] = [await receiptRow(r1.id), await receiptRow(r2.id)];
  const zero = a.appliedCents === 0n ? a : b;
  check(
    "keep $80k, one receipt unapplied, refund $80k",
    a.appliedCents + b.appliedCents === 8_000_000n &&
      zero.appliedCents === 0n &&
      (await commitmentRow(c.id)).refundDueCents === 8_000_000n,
  );
  await voidReceipt(zero.id);
  check(
    "refund due 0 after voiding the unapplied duplicate",
    (await commitmentRow(c.id)).refundDueCents === 0n,
    String((await commitmentRow(c.id)).refundDueCents),
  );
  await assertInvariant("void of unapplied duplicate");
}

async function h1Sequence() {
  console.log("H1 accept / balance / void / re-record / reduce / refund");
  const m = await newMember("H1 Sequence");
  const c = await newCommitment(m.id, 25_000_000n);
  await receive(c.id, "2026-11-03", 12_000_000n);
  await assertInvariant("held receipt");
  await accept(c.id, "2026-11-05");
  await assertInvariant("full acceptance");
  const bal = await receive(c.id, "2026-11-10", 5_000_000n);
  await assertInvariant("balance receipt");
  await voidReceipt(bal.id);
  await assertInvariant("void of fully applied balance");
  await receive(c.id, "2026-11-10", 5_000_000n);
  await assertInvariant("re-recorded balance");
  await tx((t) =>
    reduceAcceptedCommitment(
      t,
      {
        companyId,
        commitmentId: c.id,
        reduceByCents: 3_000_000n,
        reason: "integration",
      },
      actor,
    ),
  );
  await assertInvariant("reduction");
  await expectRefused(
    "overpayment after reduction refused",
    () => receive(c.id, "2026-11-11", 6_000_000n),
    /outstanding/i,
  );
  await receive(c.id, "2026-11-11", 5_000_000n);
  await assertInvariant("final balance");

  const m2 = await newMember("H1 Excess");
  const c2 = await newCommitment(m2.id, 10_000_000n);
  const r = await receive(c2.id, "2026-11-03", 12_000_000n);
  await accept(c2.id, "2026-11-05");
  check(
    "excess $20k to refund",
    (await commitmentRow(c2.id)).refundDueCents === 2_000_000n,
  );
  await tx((t) =>
    recordRefund(
      t,
      {
        companyId,
        commitmentId: c2.id,
        paidCents: 2_000_000n,
        paidOn: "2026-11-06",
      },
      actor,
    ),
  );
  await assertInvariant("excess refund paid");
  await expectRefused(
    "void of the split receipt refused",
    () => voidReceipt(r.id),
    /refund/i,
  );
  await expectRefused(
    "second refund refused",
    () =>
      tx((t) =>
        recordRefund(
          t,
          {
            companyId,
            commitmentId: c2.id,
            paidCents: 1n,
            paidOn: "2026-11-06",
          },
          actor,
        ),
      ),
    /outstanding/i,
  );
  await assertInvariant("refund sequence");
}

async function h2() {
  console.log("H2 acceptance date versus receipt dates");
  const m = await newMember("H2 Before Wire");
  const c = await newCommitment(m.id, 25_000_000n);
  const r = await receive(c.id, "2026-11-09", 10_000_000n);
  const message = await errorOf(() => accept(c.id, "2026-11-05"));
  const row = await receiptRow(r.id);
  check(
    "acceptance dated before the only wire refused (no Initial Installment)",
    message !== null && /Received \$0\.00/.test(message),
    message ??
      `accepted; appliedOn ${day(row.appliedOn)} received ${day(row.receivedOn)}`,
  );
  await assertInvariant("acceptance before wire");

  const m2 = await newMember("H2 Later Balance");
  const c2 = await newCommitment(m2.id, 10_000_000n);
  const r1 = await receive(c2.id, "2026-11-03", 4_000_000n);
  const r2 = await receive(c2.id, "2026-11-09", 3_000_000n);
  await accept(c2.id, "2026-11-05");
  const [a, b] = [await receiptRow(r1.id), await receiptRow(r2.id)];
  check(
    "earlier receipt INITIAL, applied on the acceptance date, return from the wire date",
    a.kind === "INITIAL" &&
      a.appliedCents === 4_000_000n &&
      day(a.appliedOn) === "2026-11-05" &&
      day(a.prefReturnStartDate) === "2026-11-03",
    `${a.kind} ${a.appliedCents} ${day(a.appliedOn)} ${day(a.prefReturnStartDate)}`,
  );
  check(
    "later receipt BALANCE, applied on its own date, return from the outside date",
    b.kind === "BALANCE" &&
      b.appliedCents === 3_000_000n &&
      day(b.appliedOn) === "2026-11-09" &&
      day(b.prefReturnStartDate) === "2027-03-31",
    `${b.kind} ${b.appliedCents} ${day(b.appliedOn)} ${day(b.prefReturnStartDate)}`,
  );
  await assertInvariant("acceptance with a later receipt");

  const m3 = await newMember("H2 Later Excess");
  const c3 = await newCommitment(m3.id, 10_000_000n);
  await receive(c3.id, "2026-11-03", 4_000_000n);
  const r3 = await receive(c3.id, "2026-11-09", 7_000_000n);
  await accept(c3.id, "2026-11-05");
  const later = await receiptRow(r3.id);
  check(
    "later receipt applied up to the accepted amount, excess refunded",
    later.appliedCents === 6_000_000n &&
      (await commitmentRow(c3.id)).refundDueCents === 1_000_000n,
    `${later.appliedCents} / ${(await commitmentRow(c3.id)).refundDueCents}`,
  );
  await assertInvariant("acceptance with later excess");

  const m4 = await newMember("H2 Late Entry");
  const c4 = await newCommitment(m4.id, 10_000_000n);
  await receive(c4.id, "2026-11-03", 4_000_000n);
  await accept(c4.id, "2026-11-05");
  const late = await receive(c4.id, "2026-11-04", 1_000_000n);
  const lateRow = await receiptRow(late.id);
  check(
    "receipt entered late and dated before acceptance applied on the acceptance date",
    lateRow.kind === "INITIAL" &&
      day(lateRow.appliedOn) === "2026-11-05" &&
      day(lateRow.prefReturnStartDate) === "2026-11-04",
    `${lateRow.kind} ${day(lateRow.appliedOn)} ${day(lateRow.prefReturnStartDate)}`,
  );
  await assertInvariant("late entry");
}

async function m1() {
  console.log("M1 void leaving negative capital");
  const m = await newMember("M1 Forfeit");
  const c = await newCommitment(m.id, 10_000_000n);
  const r = await receive(c.id, "2026-11-03", 4_000_000n);
  await accept(c.id, "2026-11-05");
  const f = await tx((t) =>
    recordCapitalReceipt(
      t,
      {
        companyId,
        commitmentId: c.id,
        receivedOn: "2026-11-10",
        amountCents: 0n,
        special: { kind: "FORFEITURE", appliedCents: -2_000_000n },
      },
      actor,
    ),
  );
  await assertInvariant("forfeiture");
  await expectRefused(
    "void that would leave negative capital refused",
    () => voidReceipt(r.id),
    /negative/i,
  );
  await assertInvariant("refused void");
  const message = await errorOf(() => voidReceipt(f.id));
  check(
    "void of the forfeiture itself allowed",
    message === null,
    message ?? "",
  );
  await assertInvariant("void of forfeiture");
}

async function l2() {
  console.log("L2 concurrent admissions from two class locks");
  const m = await newMember("L2 Concurrent");
  const c = await newCommitment(m.id, 10_000_000n);
  await receive(c.id, "2026-11-03", 4_000_000n);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: () => void = () => {};
  const decided = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const tx1 = db.$transaction(
    async (t) => {
      await decideCommitment(
        t,
        {
          companyId,
          commitmentId: c.id,
          decision: "ACCEPT",
          acceptedOn: "2026-11-05",
        },
        actor,
      );
      signal();
      await gate;
    },
    { timeout: 15_000 },
  );
  await decided;
  const tx2 = db.$transaction(
    (t) =>
      issueCommonUnits(
        t,
        { companyId, stakeholderId: m.id, units: "1", issuedOn: "2026-11-06" },
        actor,
      ),
    { timeout: 15_000 },
  );
  await new Promise((r) => setTimeout(r, 700));
  release();
  await Promise.all([tx1, tx2]);
  const s = await db.stakeholder.findFirstOrThrow({ where: { id: m.id } });
  const audits = await db.audit.findMany({
    where: { companyId, action: "stakeholder.admitted" },
  });
  const mine = audits.filter((a) => JSON.stringify(a.target).includes(m.id));
  check(
    "admitted once, on the earlier date",
    mine.length === 1 && day(s.admittedOn) === "2026-11-05",
    `${mine.length} admission audits, admittedOn ${day(s.admittedOn)}`,
  );
  await assertInvariant("concurrent admissions");
}

async function l4AndReplacement() {
  console.log("L4 / G1 Replacement Funder commitments");
  const m = await newMember("L4 Replacement");
  const c = await newCommitment(m.id, 3_000_000n, {
    signedOn: "2026-11-06",
    isReplacement: true,
  });
  await tx((t) =>
    decideCommitment(
      t,
      {
        companyId,
        commitmentId: c.id,
        decision: "ACCEPT",
        acceptedOn: "2026-11-06",
        skipClosingDateCheck: true,
      },
      actor,
    ),
  );
  const row = await commitmentRow(c.id);
  const audit = await db.audit.findFirst({
    where: { companyId, action: "commitment.accepted" },
    orderBy: { occurredAt: "desc" },
  });
  check(
    "replacement below the minimum is not a waiver",
    row.minimumWaived === false &&
      row.minimumWaiverNote === null &&
      !/minimum waived/.test(audit?.summary ?? "") &&
      /4\.9\(ii\)/.test(audit?.summary ?? ""),
    `${row.minimumWaived} / ${audit?.summary}`,
  );
  const rr = await tx((t) =>
    recordCapitalReceipt(
      t,
      {
        companyId,
        commitmentId: c.id,
        receivedOn: "2026-11-05",
        amountCents: 3_000_000n,
        special: { kind: "REPLACEMENT", appliedCents: 3_000_000n },
      },
      actor,
    ),
  );
  check(
    "replacement receipt dated before acceptance applied on the acceptance date",
    day((await receiptRow(rr.id)).appliedOn) === "2026-11-06",
    String(day((await receiptRow(rr.id)).appliedOn)),
  );
  await assertInvariant("replacement funding");

  const m2 = await newMember("G1 Replacement Reduced");
  const c2 = await newCommitment(m2.id, 4_000_000n, {
    signedOn: "2026-11-06",
    isReplacement: true,
  });
  await tx((t) =>
    decideCommitment(
      t,
      {
        companyId,
        commitmentId: c2.id,
        decision: "ACCEPT",
        acceptedCents: 3_000_000n,
        acceptedOn: "2026-11-06",
        skipClosingDateCheck: true,
      },
      actor,
    ),
  );
  const message = await errorOf(() =>
    tx((t) =>
      recordCapitalReceipt(
        t,
        {
          companyId,
          commitmentId: c2.id,
          receivedOn: "2026-11-06",
          amountCents: 3_000_000n,
          special: { kind: "REPLACEMENT", appliedCents: 3_000_000n },
        },
        actor,
      ),
    ),
  );
  check(
    "replacement accepted at a reduced amount can be funded",
    message === null,
    message ?? "",
  );
  await assertInvariant("reduced replacement funding");
}

async function g1() {
  console.log("G1 future dates, clearing dates, stakeholder audit, T1");
  const m = await newMember("G1 Dates", {
    currentRelationship: "EMPLOYEE",
  });
  const c = await tx((t) =>
    ledger.createCommitment(
      t,
      {
        companyId,
        stakeholderId: m.id,
        unitClassId: preferredId,
        committedCents: 10_000_000n,
        signedOn: "2026-11-02",
        investmentSummaryDate: "2026-11-01",
        accreditationBasis: "NET_WORTH",
      },
      actor,
    ),
  );
  const cleared = await errorOf(() =>
    tx((t) =>
      updatePendingCommitment(
        t,
        {
          companyId,
          commitmentId: c.id,
          signedOn: null,
          investmentSummaryDate: null,
        },
        actor,
      ),
    ),
  );
  const afterClear = await commitmentRow(c.id);
  check(
    "pending commitment dates can be cleared with null",
    cleared === null &&
      afterClear.signedOn === null &&
      afterClear.investmentSummaryDate === null,
    cleared ??
      `${day(afterClear.signedOn)} ${day(afterClear.investmentSummaryDate)}`,
  );
  await tx((t) =>
    updatePendingCommitment(
      t,
      { companyId, commitmentId: c.id, signedOn: "2026-11-02" },
      actor,
    ),
  );
  await receive(c.id, "2026-11-03", 4_000_000n);
  await accept(c.id, "2026-11-05");
  const audit = await db.audit.findFirst({
    where: { companyId, action: "commitment.accepted" },
    orderBy: { occurredAt: "desc" },
  });
  check(
    "acceptance audit records the stakeholder changes",
    /relationship/i.test(audit?.summary ?? "") &&
      /accreditation/i.test(audit?.summary ?? ""),
    audit?.summary ?? "no audit",
  );
  const future = "2099-01-01";
  await expectRefused(
    "CREDIT with a future date refused",
    () =>
      tx((t) =>
        recordCapitalReceipt(
          t,
          {
            companyId,
            commitmentId: c.id,
            receivedOn: future,
            amountCents: 0n,
            special: { kind: "CREDIT", appliedCents: 100_000n },
          },
          actor,
        ),
      ),
    /future/i,
  );
  await expectRefused(
    "FORFEITURE with a future date refused",
    () =>
      tx((t) =>
        recordCapitalReceipt(
          t,
          {
            companyId,
            commitmentId: c.id,
            receivedOn: future,
            amountCents: 0n,
            special: { kind: "FORFEITURE", appliedCents: -100_000n },
          },
          actor,
        ),
      ),
    /future/i,
  );
  await expectRefused(
    "Common Units issued on a future date refused",
    () =>
      tx((t) =>
        issueCommonUnits(
          t,
          { companyId, stakeholderId: m.id, units: "1", issuedOn: future },
          actor,
        ),
      ),
    /future/i,
  );
  const m2 = await newMember("G1 Refund");
  const c2 = await newCommitment(m2.id, 10_000_000n);
  await receive(c2.id, "2026-11-03", 12_000_000n);
  await accept(c2.id, "2026-11-05");
  await expectRefused(
    "refund paid on a future date refused",
    () =>
      tx((t) =>
        recordRefund(
          t,
          { companyId, commitmentId: c2.id, paidCents: 100n, paidOn: future },
          actor,
        ),
      ),
    /future/i,
  );
  check(
    "refreshSubscriptionClock is not exported",
    !("refreshSubscriptionClock" in ledger),
  );
  await assertInvariant("G1");
}

// ---------------------------------------------------------------------------
// Guarded writes under concurrency (src/server/guarded-write.ts)
//
// Prisma's `updateMany` re-selects ids first and drops its filter from the
// UPDATE, so a writer that blocked on the row lock overwrote the row after
// the other transaction committed. Each race below holds a transaction that
// changes the guarded row, starts the service call (which blocks on that
// row), confirms the wait in pg_stat_activity, then releases.

const bucketIds: string[] = [];

/** Runs `fn` in a transaction that stays open until `release()` is called. */
async function holdOpen(fn: (t: Tx) => Promise<void>) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = db.$transaction(
    async (t) => {
      await fn(t);
      ready();
      await gate;
    },
    { timeout: 15_000 },
  );
  await held;
  return { release, done };
}

/** Statements currently waiting on a lock in this database. */
async function lockWaits(): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 700));
  const rows = await db.$queryRaw<{ q: string }[]>`
    SELECT left(query, 120) AS q FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return rows.map((r) => r.q);
}

function reject(t: Tx, commitmentId: string) {
  return decideCommitment(
    t,
    {
      companyId,
      commitmentId,
      decision: "REJECT",
      acceptedOn: "2026-11-05",
      rejectionReason: "integration rejection",
    },
    actor,
  );
}

async function guardedPacket() {
  console.log("Guarded writes: rejection and the Exhibit B packet");
  const bucket = await db.bucket.create({
    data: {
      name: "zz ledger packet",
      key: `zz-ledger-${randomUUID()}`,
      mimeType: "application/pdf",
      size: 1,
    },
  });
  bucketIds.push(bucket.id);
  const newPacket = (commitmentId: string) =>
    db.template.create({
      data: {
        publicId: `zz-ledger-${randomUUID()}`,
        name: "Exhibit B",
        status: "PENDING",
        bucketId: bucket.id,
        uploaderId: memberId,
        companyId,
        commitmentId,
      },
    });
  const rejectionAudit = (name: string) =>
    db.audit.findFirst({
      where: {
        companyId,
        action: "commitment.rejected",
        summary: { contains: name },
      },
    });

  // No packet: the guarded write matches nothing (P2025) and the rest of the
  // transaction still runs.
  const a = await newMember("Packet None");
  const ca = await newCommitment(a.id, 10_000_000n);
  await tx((t) => reject(t, ca.id));
  const auditA = await rejectionAudit("Packet None");
  check(
    "rejection without a packet completes and is audited",
    (await commitmentRow(ca.id)).status === "REJECTED" &&
      auditA !== null &&
      !auditA.summary?.includes("packet"),
    auditA?.summary ?? "no audit row",
  );

  // Pending packet: cancelled.
  const b = await newMember("Packet Pending");
  const cb = await newCommitment(b.id, 10_000_000n);
  const pb = await newPacket(cb.id);
  await tx((t) => reject(t, cb.id));
  const packetB = await db.template.findFirstOrThrow({ where: { id: pb.id } });
  const auditB = await rejectionAudit("Packet Pending");
  check(
    "rejection cancels a pending Exhibit B packet",
    packetB.status === "CANCELLED" &&
      auditB?.summary?.includes("the Exhibit B packet was cancelled") === true,
    `${packetB.status}; ${auditB?.summary}`,
  );

  // Race: the packet completes (e-sign job, no unit class lock) while the
  // rejection is in flight. The completed packet must stay COMPLETE.
  const c = await newMember("Packet Race");
  const cc = await newCommitment(c.id, 10_000_000n);
  const pc = await newPacket(cc.id);
  const hold = await holdOpen(async (t) => {
    await t.template.update({
      where: { id: pc.id },
      data: { status: "COMPLETE", completedOn: new Date() },
    });
  });
  const rejection = errorOf(() => tx((t) => reject(t, cc.id)));
  const waits = await lockWaits();
  check(
    "rejection waits on the packet row",
    waits.some((q) => q.includes('"Template"')),
    JSON.stringify(waits),
  );
  hold.release();
  await hold.done;
  const message = await rejection;
  const packetC = await db.template.findFirstOrThrow({ where: { id: pc.id } });
  const auditC = await rejectionAudit("Packet Race");
  check(
    "a packet completed during the rejection stays COMPLETE",
    message === null &&
      packetC.status === "COMPLETE" &&
      auditC !== null &&
      !auditC.summary?.includes("packet"),
    `${message ?? "rejected"}; packet ${packetC.status}; ${auditC?.summary}`,
  );
  await assertInvariant("packet races");
}

async function guardedVoidReopen() {
  console.log("Guarded writes: voiding a receipt re-opens its Call Notice");
  let noticeNumber = 9_000;
  /** Accepted commitment with one Balance receipt allocated in full to a
   *  PAID line of a SETTLED notice. */
  async function fixture(name: string) {
    const m = await newMember(name);
    const c = await newCommitment(m.id, 10_000_000n);
    await receive(c.id, "2026-11-03", 4_000_000n);
    await accept(c.id, "2026-11-04");
    const receipt = await receive(c.id, "2026-11-06", 1_000_000n);
    noticeNumber += 1;
    const notice = await db.callNotice.create({
      data: {
        companyId,
        number: noticeNumber,
        status: "SETTLED",
        sentAt: new Date("2026-11-05T12:00:00Z"),
        createdById: memberId,
      },
    });
    const line = await db.callNoticeLine.create({
      data: {
        companyId,
        callNoticeId: notice.id,
        stakeholderId: m.id,
        commitmentId: c.id,
        amountCalledCents: 1_000_000n,
        status: "PAID",
        sentAt: new Date("2026-11-05T12:00:00Z"),
        sentOn: new Date("2026-11-05"),
        dueOn: new Date("2026-11-06"),
        paidInFullOn: new Date("2026-11-06"),
      },
    });
    await db.callNoticeAllocation.create({
      data: {
        companyId,
        callNoticeLineId: line.id,
        capitalReceiptId: receipt.id,
        amountCents: 1_000_000n,
        receivedOn: new Date("2026-11-06"),
        prefReturnStartOn: new Date("2026-11-06"),
        source: "PAYMENT",
        createdById: memberId,
      },
    });
    return { receipt, notice, line };
  }

  const plain = await fixture("Void Reopen");
  await voidReceipt(plain.receipt.id);
  const lineA = await db.callNoticeLine.findFirstOrThrow({
    where: { id: plain.line.id },
  });
  const noticeA = await db.callNotice.findFirstOrThrow({
    where: { id: plain.notice.id },
  });
  const negated = await db.callNoticeAllocation.count({
    where: {
      companyId,
      callNoticeLineId: plain.line.id,
      amountCents: { lt: 0n },
    },
  });
  check(
    "void re-opens the PAID line and the SETTLED notice",
    lineA.status === "SENT" &&
      lineA.paidInFullOn === null &&
      noticeA.status === "SENT" &&
      negated === 1,
    `line ${lineA.status}, notice ${noticeA.status}, negations ${negated}`,
  );

  // Race: the line and the notice leave PAID / SETTLED in another
  // transaction while the void is in flight. The void must not write over
  // them (nothing does this today; it proves the guard holds).
  const race = await fixture("Void Race");
  const hold = await holdOpen(async (t) => {
    await t.callNoticeLine.update({
      where: { id: race.line.id },
      data: { status: "UNSENT", paidInFullOn: null },
    });
    await t.callNotice.update({
      where: { id: race.notice.id },
      data: { status: "CANCELLED" },
    });
  });
  const voiding = errorOf(() => voidReceipt(race.receipt.id));
  const waits = await lockWaits();
  check(
    "void waits on the Call Notice line row",
    waits.some((q) => q.includes('"CallNoticeLine"')),
    JSON.stringify(waits),
  );
  hold.release();
  await hold.done;
  const message = await voiding;
  const lineB = await db.callNoticeLine.findFirstOrThrow({
    where: { id: race.line.id },
  });
  const noticeB = await db.callNotice.findFirstOrThrow({
    where: { id: race.notice.id },
  });
  const voided = await receiptRow(race.receipt.id);
  check(
    "void leaves a line and notice changed meanwhile as they are",
    message === null &&
      voided.voidedAt !== null &&
      lineB.status === "UNSENT" &&
      noticeB.status === "CANCELLED",
    `${message ?? "voided"}; line ${lineB.status}, notice ${noticeB.status}`,
  );

  // Same, with only the notice changing (the line write goes through, the
  // notice write is the one that waits).
  const race2 = await fixture("Void Race Notice");
  const hold2 = await holdOpen(async (t) => {
    await t.callNotice.update({
      where: { id: race2.notice.id },
      data: { status: "CANCELLED" },
    });
  });
  const voiding2 = errorOf(() => voidReceipt(race2.receipt.id));
  const waits2 = await lockWaits();
  check(
    "void waits on the Call Notice row",
    waits2.some((q) => q.includes('"CallNotice"')),
    JSON.stringify(waits2),
  );
  hold2.release();
  await hold2.done;
  const message2 = await voiding2;
  const lineC = await db.callNoticeLine.findFirstOrThrow({
    where: { id: race2.line.id },
  });
  const noticeC = await db.callNotice.findFirstOrThrow({
    where: { id: race2.notice.id },
  });
  check(
    "void re-opens the line but leaves a notice changed meanwhile as it is",
    message2 === null &&
      lineC.status === "SENT" &&
      noticeC.status === "CANCELLED",
    `${message2 ?? "voided"}; line ${lineC.status}, notice ${noticeC.status}`,
  );
  await assertInvariant("void re-open races");
}

async function guardedMemberStatus() {
  console.log("Guarded writes: member status change racing another");
  const m = await newMember("Status Race", {
    memberStatus: "MEMBER",
    admittedOn: new Date("2026-11-01"),
  });
  const caller = makeStakeholderCaller();
  const hold = await holdOpen(async (t) => {
    await t.stakeholder.update({
      where: { id: m.id },
      data: { memberStatus: "FINANCIAL_INTEREST_ONLY" },
    });
  });
  const change = errorOf(() =>
    caller.setMemberStatus({
      id: m.id,
      memberStatus: "FINANCIAL_INTEREST_ONLY",
      reason: "integration race",
    }),
  );
  const waits = await lockWaits();
  check(
    "status change waits on the stakeholder row",
    waits.some((q) => q.includes('"Stakeholder"')),
    JSON.stringify(waits),
  );
  hold.release();
  await hold.done;
  const message = await change;
  const audits = await db.audit.count({
    where: {
      companyId,
      action: "stakeholder.updated",
      summary: { contains: "changed the status of Status Race" },
    },
  });
  check(
    "a status change that no longer applies is refused, not recorded twice",
    message !== null && /Status can only change/.test(message) && audits === 0,
    `${message ?? "it succeeded"}; ${audits} status audit rows`,
  );
  const ok = await errorOf(() =>
    caller.setMemberStatus({
      id: m.id,
      memberStatus: "MEMBER",
      reason: "integration back",
    }),
  );
  const after = await db.stakeholder.findFirstOrThrow({ where: { id: m.id } });
  check(
    "an uncontended status change still applies",
    ok === null && after.memberStatus === "MEMBER",
    ok ?? after.memberStatus,
  );
}

// ---------------------------------------------------------------------------
// Setup, caller, cleanup

let userId = "";
let memberId = "";

function makeStakeholderCaller() {
  const session = {
    user: {
      id: userId,
      name: "Integration",
      email: `${userId}@ledger-integration.test`,
      companyId,
      memberId,
      companyPublicId: "x",
      isOnboarded: true,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;
  return createCallerFactory(stakeholderRouter)({
    db,
    session,
    requestIp: "127.0.0.1",
    userAgent: "ledger-integration",
    headers: new Headers(),
  });
}

function makeCaller() {
  const session = {
    user: {
      id: userId,
      name: "Integration",
      email: `${userId}@ledger-integration.test`,
      companyId,
      memberId,
      companyPublicId: "x",
      isOnboarded: true,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;
  return createCallerFactory(unitClassRouter)({
    db,
    session,
    requestIp: "127.0.0.1",
    userAgent: "ledger-integration",
    headers: new Headers(),
  });
}

async function setup() {
  const company = await db.company.create({
    data: {
      name: `zz ledger integration ${new Date().toISOString()}`,
      publicId: `zz-ledger-${randomUUID()}`,
      incorporationType: "llc",
      incorporationDate: new Date("2026-01-01"),
      incorporationCountry: "US",
      incorporationState: "WY",
      streetAddress: "1 Test St",
      city: "Cheyenne",
      state: "WY",
      zipcode: "82001",
      country: "US",
      entityType: "LLC",
      timezone: "America/Denver",
    },
  });
  companyId = company.id;
  const pref = await db.unitClass.create({
    data: {
      companyId,
      name: "Preferred Units",
      kind: "PREFERRED",
      pricePerUnitCents: 100_000n,
      fractionalUnitsAllowed: true,
      votesPerUnit: 1,
      prefReturnBps: 800,
      residualSplitBps: 7000,
      minCommitmentCents: 10_000_000n,
      minCommitmentFloorCents: 5_000_000n,
      offeringCapCents: 200_000_000n,
      initialInstallmentBps: 4000,
      finalClosingDate: new Date("2026-11-30"),
      balanceOutsideDate: new Date("2027-03-31"),
    },
  });
  preferredId = pref.id;
  const common = await db.unitClass.create({
    data: {
      companyId,
      name: "Common Units",
      kind: "COMMON",
      authorizedUnits: 1000,
      fractionalUnitsAllowed: false,
      residualSplitBps: 3000,
    },
  });
  commonId = common.id;
  const user = await db.user.create({
    data: {
      name: "Integration",
      email: `${randomUUID()}@ledger-integration.test`,
    },
  });
  userId = user.id;
  const member = await db.member.create({
    data: {
      companyId,
      userId,
      status: "ACTIVE",
      isOnboarded: true,
      role: "ADMIN",
    },
  });
  memberId = member.id;
}

async function cleanup() {
  if (!companyId) return;
  const id = companyId;
  await db.$executeRaw`DELETE FROM "Audit" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "CallNoticeAllocation" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "CallNoticeLine" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "CallNotice" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "Template" WHERE "companyId" = ${id}`;
  if (bucketIds.length > 0) {
    await db.bucket.deleteMany({ where: { id: { in: bucketIds } } });
  }
  await db.$executeRaw`DELETE FROM "CapitalReceipt" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "Commitment" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "Stakeholder" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "UnitClass" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "Member" WHERE "companyId" = ${id}`;
  await db.$executeRaw`DELETE FROM "Company" WHERE id = ${id}`;
  if (userId) await db.$executeRaw`DELETE FROM "User" WHERE id = ${userId}`;
  const left = await db.$queryRaw<{ n: bigint }[]>`
    SELECT (SELECT count(*) FROM "Audit" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "CallNoticeAllocation" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "CallNoticeLine" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "CallNotice" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "Template" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "Bucket" WHERE id = ANY(${bucketIds}::text[]))
         + (SELECT count(*) FROM "CapitalReceipt" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "Commitment" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "Stakeholder" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "UnitClass" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "Member" WHERE "companyId" = ${id})
         + (SELECT count(*) FROM "Company" WHERE id = ${id}) AS n`;
  console.log(`cleanup: ${left[0]?.n ?? "?"} rows left for the test company`);
}

async function main() {
  try {
    await setup();
    const caller = makeCaller();
    const scenarios: [string, () => Promise<void>][] = [
      ["M2 race", () => m2Race(caller)],
      ["H1 reduced", h1Reduced],
      ["H1 rejected", h1RejectedDuplicate],
      ["H1 zero applied", h1ZeroAppliedDuplicate],
      ["H1 sequence", h1Sequence],
      ["H2", h2],
      ["M1", m1],
      ["L2", l2],
      ["L4", l4AndReplacement],
      ["G1", g1],
      ["M2 reductions", () => m2Reductions(caller)],
      ["Guarded packet", guardedPacket],
      ["Guarded void re-open", guardedVoidReopen],
      ["Guarded member status", guardedMemberStatus],
    ];
    for (const [name, run] of scenarios) {
      const message = await errorOf(run);
      if (message !== null) check(`${name} ran to the end`, false, message);
    }
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log(failures.map((f) => `- ${f}`).join("\n"));
    process.exit(1);
  }
}

void main();
