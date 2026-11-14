import "server-only";

import type { CallNoticeLineStatusEnum } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { render } from "react-email";
import { CallNoticeEmail } from "@/emails/llc/CallNoticeEmail";
import { formatDateOnly, fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { LlcEconomicsConfig } from "@/lib/llc/config";
import { type IsoDate, minIso } from "@/lib/llc/dates";
import {
  callNoticeDueDate,
  forfeitureDate,
  type OpenLine,
} from "@/lib/llc/default";
import { type Cents, LlcMathError } from "@/lib/llc/money";
import { logger } from "@/lib/logger";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import {
  getWireInstructions,
  type WireInstructions,
} from "@/server/bank-accounts";
import type {
  PrismaTransactionalClient,
  TPrisma,
  TPrismaOrTransaction,
} from "@/server/db";
import {
  type LedgerActor,
  lockUnitClass,
  recordCapitalReceipt,
  setReceiptPrefReturnStart,
} from "@/server/llc/commitments";
import { isMailCatcherConfigured, sendMail } from "@/server/mailer";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import {
  type BalancePaymentPlan,
  calendarDate,
  callNoticeReference,
  callNoticeSubject,
  commitmentFigures,
  formatNoticeAmounts,
  lineFigures,
  longDate,
  maskedAccountNumber,
  type NoticeTermsText,
  noticeAmounts,
  noticeTermsText,
  type PrepaidMatch,
  type PrepaidReceipt,
  planBalancePayment,
  planPrepaidMatch,
  sendBlockedReason,
} from "./call-notices.logic";
import { economicsToday } from "./clock";
import { receiptDateBlocker } from "./receipt-guards";
import { conflict, lockCompanyLedger, notFound, ruleViolation } from "./scope";
import { getEconomicsContext, requireOutsideDate } from "./term";

/*
 * Call Notices (R26–R29, §4.9). A Call Notice is effective when its email is
 * accepted by the mail server: the due date printed in the email is stored
 * on the line, and Balance money already received is matched to the line
 * after it is sent. Allocations are immutable (corrections are negating rows,
 * written by `beforeVoidReceipt` in receipt-guards.ts).
 *
 * Send path (reserve → send → finalise → reconcile):
 * A. One locked transaction moves the target lines UNSENT/SEND_FAILED →
 *    SENDING after every check (the uncalled Balance counts SENDING, SENT and
 *    PAID lines of every notice). Nothing is emailed for a line that is not
 *    SENDING, so two concurrent sends cannot both email it.
 * B. Each email is rendered just before it is sent (the due date is computed
 *    from that day). A failed send moves SENDING → SEND_FAILED.
 * C. An accepted email is recorded by a small write SENDING → SENT that takes
 *    no lock and re-checks nothing; then a separate locked transaction
 *    matches prepaid money and sets `prepaidMatchedAt`. If that fails, the
 *    marker stays null and `reconcileCallNoticeLines` finishes it later (at
 *    the next payment of the member, or "Re-match prepaid money").
 * A line left in SENDING (crash between B and C) is never flipped
 * automatically: `resolveCallNoticeSending` lets the Manager resolve it.
 *
 * Locks: `lockCompanyLedger` (advisory) first, then FOUNDATION's unit-class
 * row lock on the Preferred class, the same order FOUNDATION's receipt
 * services use inside economics flows; `voidCapitalReceipt` takes only the
 * unit-class lock, so prepaid matching and a void are serialised.
 */

type Tx = PrismaTransactionalClient;
type Reader = TPrismaOrTransaction;

const SENDABLE: CallNoticeLineStatusEnum[] = ["UNSENT", "SEND_FAILED"];
/** Lines whose amount counts as called (whatever the notice status). */
const CALLED: CallNoticeLineStatusEnum[] = ["SENDING", "SENT", "PAID"];
/** A SENDING line can be resolved by the Manager only after this long. */
export const SENDING_RESOLVE_AFTER_MS = 2 * 60 * 1000;
const SEND_TX = { maxWait: 10_000, timeout: 20_000 };
const MATCH_TX = { maxWait: 5_000, timeout: 10_000 };

const SEND_FAILED_TEXT =
  "The email could not be sent; nothing was delivered. The line is marked 'Send failed' and can be retried.";
const PREPARE_FAILED_TEXT =
  "The email could not be prepared, so it was not sent. The line is marked 'Send failed' and can be retried.";
const RECORD_FAILED_TEXT =
  "The email was sent, but recording it failed. Do not resend: the line is shown as 'Sending'; resolve it on the notice page.";
const MATCH_FAILED_TEXT =
  "The email was sent and the line is recorded as sent, but matching money already received to it failed. Do not resend; use 'Re-match prepaid money' on the notice page.";

function isRecordNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2025";
}

/**
 * The advisory ledger lock, then FOUNDATION's row lock on the Preferred unit
 * class (`lockUnitClass`). Returns the class's Balance return start rule.
 */
async function lockLedgerAndPreferred(
  tx: Tx,
  companyId: string,
): Promise<{ rule: LlcEconomicsConfig["balanceReturnStartRule"] } | null> {
  await lockCompanyLedger(tx, companyId);
  const preferred = await tx.unitClass.findFirst({
    where: { companyId, kind: "PREFERRED" },
    select: { id: true },
  });
  if (!preferred) return null;
  await lockUnitClass(tx, companyId, preferred.id);
  const fresh = await tx.unitClass.findFirst({
    where: { id: preferred.id, companyId },
    select: { balanceReturnStartRule: true },
  });
  return fresh ? { rule: fresh.balanceReturnStartRule } : null;
}

function dateOrNull(d: Date | null): IsoDate | null {
  return d === null ? null : toDateOnly(d);
}

function createdBy(actor: LedgerActor): string {
  return actor.memberId ?? actor.userId;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, "en");
}

async function audit(
  tx: Reader,
  actor: LedgerActor,
  companyId: string,
  action: AuditSchemaType["action"],
  target: AuditSchemaType["target"],
  summary: string,
): Promise<void> {
  await Audit.create(
    {
      action,
      companyId,
      actor: { type: "user", id: actor.userId },
      context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
      target,
      summary,
    },
    tx,
  );
}

/**
 * The due date of a notice accepted on `acceptedOn` whose email printed
 * `printed`: never earlier than the printed date nor than the date the notice
 * period gives from the day it was accepted, so a send crossing midnight
 * cannot shorten the notice period.
 */
function finalDueOn(
  printed: IsoDate,
  acceptedOn: IsoDate,
  config: LlcEconomicsConfig,
): IsoDate {
  try {
    const fromAccepted = callNoticeDueDate(acceptedOn, config);
    return fromAccepted > printed ? fromAccepted : printed;
  } catch (error) {
    if (error instanceof LlcMathError) return printed;
    throw error;
  }
}

/** callNoticeDueDate with a BAD_REQUEST instead of a library error after the outside date. */
function dueDateFor(today: IsoDate, config: LlcEconomicsConfig): IsoDate {
  try {
    return callNoticeDueDate(today, config);
  } catch (error) {
    if (error instanceof LlcMathError && error.code === "AFTER_OUTSIDE_DATE") {
      ruleViolation(
        "The Balance is already due under Section 4.9 (March 31, 2027); use 'Record Balance due' instead.",
      );
    }
    throw error;
  }
}

async function nextNoticeNumber(tx: Tx, companyId: string): Promise<number> {
  const max = await tx.callNotice.aggregate({
    where: { companyId },
    _max: { number: true },
  });
  return (max._max.number ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Commitment states

export interface CommitmentState {
  commitmentId: string;
  stakeholderId: string;
  name: string;
  /** The address a Call Notice goes to: Stakeholder.noticeEmail, or email when that is empty (null when both are blank). */
  noticeEmail: string | null;
  /** Commitment.acceptedOn: a payment received on or before it is an Initial Installment. */
  acceptedOn: IsoDate | null;
  /** Commitment.acceptedCents, already net of replacement funding. */
  acceptedCents: Cents;
  /** Σ MemberDefaultFunding on this commitment's defaults. */
  replacementFunded: Cents;
  /** Σ appliedCents of INITIAL receipts. */
  initialPaid: Cents;
  /** acceptedCents − initialPaid. */
  balance: Cents;
  /** Σ amountCalled of lines being sent, sent or paid (SENDING, SENT, PAID), whatever the notice status. */
  calledTotal: Cents;
  /** uncalledBalance({ acceptedCommitment: acceptedCents + replacementFunded, initialPaid, calledTotal }). */
  uncalled: Cents;
  /** Σ appliedCents of BALANCE receipts. */
  balancePaid: Cents;
  /** balancePaid − Σ net allocations. */
  prepaidUnallocated: Cents;
  /** Cash applied as capital (INITIAL + BALANCE + REPLACEMENT). */
  totalPaid: Cents;
  /** acceptedCents − totalPaid. */
  remainingCommitment: Cents;
}

/** Preferred commitments with status ACCEPTED or REDUCED and isReplacement = false, by member name. */
export async function getCommitmentStates(
  tx: Reader,
  companyId: string,
  filter?: { commitmentIds?: readonly string[] },
): Promise<CommitmentState[]> {
  const preferred = await tx.unitClass.findFirst({
    where: { companyId, kind: "PREFERRED" },
    select: { id: true },
  });
  if (!preferred) return [];
  const commitments = await tx.commitment.findMany({
    where: {
      companyId,
      unitClassId: preferred.id,
      status: { in: ["ACCEPTED", "REDUCED"] },
      isReplacement: false,
      ...(filter?.commitmentIds
        ? { id: { in: [...filter.commitmentIds] } }
        : {}),
    },
    select: {
      id: true,
      stakeholderId: true,
      acceptedCents: true,
      acceptedOn: true,
      stakeholder: { select: { name: true, email: true, noticeEmail: true } },
    },
  });
  if (commitments.length === 0) return [];
  const ids = commitments.map((c) => c.id);

  const receipts = await tx.capitalReceipt.findMany({
    where: { companyId, commitmentId: { in: ids }, voidedAt: null },
    select: { id: true, commitmentId: true, kind: true, appliedCents: true },
  });
  const balanceReceiptIds = receipts
    .filter((r) => r.kind === "BALANCE")
    .map((r) => r.id);
  const allocated =
    balanceReceiptIds.length === 0
      ? []
      : await tx.callNoticeAllocation.groupBy({
          by: ["capitalReceiptId"],
          where: { companyId, capitalReceiptId: { in: balanceReceiptIds } },
          _sum: { amountCents: true },
        });
  const allocatedByReceipt = new Map(
    allocated.map((a) => [a.capitalReceiptId, a._sum.amountCents ?? 0n]),
  );

  // Every line that is being sent, was sent or was paid calls its amount,
  // whatever its notice's status: an emailed demand stays called.
  const sentLines = await tx.callNoticeLine.findMany({
    where: {
      companyId,
      commitmentId: { in: ids },
      status: { in: CALLED },
    },
    select: { commitmentId: true, amountCalledCents: true },
  });

  const defaults = await tx.memberDefault.findMany({
    where: { companyId, commitmentId: { in: ids } },
    select: { id: true, commitmentId: true },
  });
  const fundings =
    defaults.length === 0
      ? []
      : await tx.memberDefaultFunding.findMany({
          where: {
            companyId,
            memberDefaultId: { in: defaults.map((d) => d.id) },
          },
          select: { memberDefaultId: true, amountCents: true },
        });
  const commitmentOfDefault = new Map(
    defaults.map((d) => [d.id, d.commitmentId]),
  );

  const states = commitments.map((c): CommitmentState => {
    const own = receipts.filter((r) => r.commitmentId === c.id);
    const netAllocated = own
      .filter((r) => r.kind === "BALANCE")
      .reduce((s, r) => s + (allocatedByReceipt.get(r.id) ?? 0n), 0n);
    const calledTotal = sentLines
      .filter((l) => l.commitmentId === c.id)
      .reduce((s, l) => s + l.amountCalledCents, 0n);
    const replacementFunded = fundings
      .filter((f) => commitmentOfDefault.get(f.memberDefaultId) === c.id)
      .reduce((s, f) => s + f.amountCents, 0n);
    const address =
      c.stakeholder.noticeEmail?.trim() || c.stakeholder.email.trim();
    return {
      commitmentId: c.id,
      stakeholderId: c.stakeholderId,
      name: c.stakeholder.name,
      noticeEmail: address === "" ? null : address,
      acceptedOn: dateOrNull(c.acceptedOn),
      acceptedCents: c.acceptedCents,
      ...commitmentFigures({
        acceptedCents: c.acceptedCents,
        receipts: own,
        netAllocated,
        calledTotal,
        replacementFunded,
      }),
    };
  });
  return states.sort(byName);
}

export interface CapitalTotals {
  /** Σ acceptedCents of every ACCEPTED / REDUCED Preferred commitment. */
  committed: Cents;
  /** Cash applied as capital: Σ INITIAL + BALANCE + REPLACEMENT receipts. */
  paid: Cents;
  /** Σ uncalled Balance of the callable (non-replacement) commitments. */
  uncalled: Cents;
}

/**
 * Committed, paid and uncalled capital of the Preferred class (optionally of
 * one holder), reconciling with the ledger (`getClassTotals` committed and
 * cash applied). `getCommitmentStates` lists the CALLABLE commitments only
 * (`isReplacement = false`); a Replacement Funder's commitment is added here:
 * the defaulter's commitment is already reduced by the funded amount
 * (`reduceAcceptedCommitment`) and the funder's new commitment carries it
 * with its REPLACEMENT receipt, so each dollar is counted once. A replacement
 * commitment is funded in full when it is made and is never called, so it
 * adds nothing to `uncalled`.
 */
export async function getCapitalTotals(
  tx: Reader,
  companyId: string,
  filter?: { stakeholderId?: string },
): Promise<CapitalTotals> {
  const states = (await getCommitmentStates(tx, companyId)).filter(
    (s) =>
      filter?.stakeholderId === undefined ||
      s.stakeholderId === filter.stakeholderId,
  );
  let committed = 0n;
  let paid = 0n;
  let uncalled = 0n;
  for (const s of states) {
    committed += s.acceptedCents;
    paid += s.totalPaid;
    uncalled += s.uncalled;
  }
  const preferred = await tx.unitClass.findFirst({
    where: { companyId, kind: "PREFERRED" },
    select: { id: true },
  });
  if (!preferred) return { committed, paid, uncalled };
  const replacements = await tx.commitment.findMany({
    where: {
      companyId,
      unitClassId: preferred.id,
      status: { in: ["ACCEPTED", "REDUCED"] },
      isReplacement: true,
      ...(filter?.stakeholderId ? { stakeholderId: filter.stakeholderId } : {}),
    },
    select: { id: true, acceptedCents: true },
  });
  if (replacements.length === 0) return { committed, paid, uncalled };
  for (const r of replacements) committed += r.acceptedCents;
  const cash = await tx.capitalReceipt.aggregate({
    where: {
      companyId,
      commitmentId: { in: replacements.map((r) => r.id) },
      voidedAt: null,
      kind: { in: ["INITIAL", "BALANCE", "REPLACEMENT"] },
    },
    _sum: { appliedCents: true },
  });
  paid += cash._sum.appliedCents ?? 0n;
  return { committed, paid, uncalled };
}

/** The commitment's BALANCE receipts with money not yet allocated to a line, oldest first. */
async function loadPrepaidReceipts(
  tx: Reader,
  companyId: string,
  commitmentId: string,
): Promise<(PrepaidReceipt & { prefReturnStartDate: IsoDate | null })[]> {
  const receipts = await tx.capitalReceipt.findMany({
    where: {
      companyId,
      commitmentId,
      kind: "BALANCE",
      voidedAt: null,
      appliedCents: { gt: 0n },
    },
    orderBy: [{ receivedOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      receivedOn: true,
      appliedCents: true,
      prefReturnStartDate: true,
    },
  });
  if (receipts.length === 0) return [];
  const allocated = await tx.callNoticeAllocation.groupBy({
    by: ["capitalReceiptId"],
    where: { companyId, capitalReceiptId: { in: receipts.map((r) => r.id) } },
    _sum: { amountCents: true },
  });
  const byReceipt = new Map(
    allocated.map((a) => [a.capitalReceiptId, a._sum.amountCents ?? 0n]),
  );
  return receipts.map((r) => ({
    receiptId: r.id,
    receivedOn: toDateOnly(r.receivedOn),
    unallocated: r.appliedCents - (byReceipt.get(r.id) ?? 0n),
    prefReturnStartDate: dateOrNull(r.prefReturnStartDate),
  }));
}

// ---------------------------------------------------------------------------
// Line states

export interface LineState {
  lineId: string;
  callNoticeId: string;
  stakeholderId: string;
  commitmentId: string;
  amountCalled: Cents;
  /** Σ net CallNoticeAllocation amounts of the line. */
  allocated: Cents;
  /** Σ MemberDefaultFunding of the line's MemberDefault. */
  replacementFunded: Cents;
  /** amountCalled − allocated − replacementFunded. */
  outstanding: Cents;
  dueOn: IsoDate | null;
  status: CallNoticeLineStatusEnum;
  /** status SENT && dueOn < today && outstanding > 0. */
  overdue: boolean;
  memberDefaultId: string | null;
}

/** Lines ordered by notice number, then creation (the order payments are applied in on equal due dates). */
export async function getLineStates(
  tx: Reader,
  companyId: string,
  today: IsoDate,
  filter?: { callNoticeId?: string; commitmentId?: string },
): Promise<LineState[]> {
  const lines = await tx.callNoticeLine.findMany({
    where: {
      companyId,
      ...(filter?.callNoticeId ? { callNoticeId: filter.callNoticeId } : {}),
      ...(filter?.commitmentId ? { commitmentId: filter.commitmentId } : {}),
    },
    orderBy: [
      { callNotice: { number: "asc" } },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: {
      id: true,
      callNoticeId: true,
      stakeholderId: true,
      commitmentId: true,
      amountCalledCents: true,
      dueOn: true,
      status: true,
      memberDefault: { select: { id: true } },
    },
  });
  if (lines.length === 0) return [];
  const allocations = await tx.callNoticeAllocation.groupBy({
    by: ["callNoticeLineId"],
    where: { companyId, callNoticeLineId: { in: lines.map((l) => l.id) } },
    _sum: { amountCents: true },
  });
  const allocatedByLine = new Map(
    allocations.map((a) => [a.callNoticeLineId, a._sum.amountCents ?? 0n]),
  );
  const defaultIds = lines
    .map((l) => l.memberDefault?.id)
    .filter((id): id is string => id !== undefined);
  const fundings =
    defaultIds.length === 0
      ? []
      : await tx.memberDefaultFunding.groupBy({
          by: ["memberDefaultId"],
          where: { companyId, memberDefaultId: { in: defaultIds } },
          _sum: { amountCents: true },
        });
  const fundedByDefault = new Map(
    fundings.map((f) => [f.memberDefaultId, f._sum.amountCents ?? 0n]),
  );
  return lines.map((l) => {
    const memberDefaultId = l.memberDefault?.id ?? null;
    const allocated = allocatedByLine.get(l.id) ?? 0n;
    const replacementFunded =
      memberDefaultId === null
        ? 0n
        : (fundedByDefault.get(memberDefaultId) ?? 0n);
    const dueOn = dateOrNull(l.dueOn);
    const { outstanding, overdue } = lineFigures({
      amountCalled: l.amountCalledCents,
      allocated,
      replacementFunded,
      status: l.status,
      dueOn,
      today,
    });
    return {
      lineId: l.id,
      callNoticeId: l.callNoticeId,
      stakeholderId: l.stakeholderId,
      commitmentId: l.commitmentId,
      amountCalled: l.amountCalledCents,
      allocated,
      replacementFunded,
      outstanding,
      dueOn,
      status: l.status,
      overdue,
      memberDefaultId,
    };
  });
}

/** Notices whose lines are all PAID become SETTLED (also used by E11). */
export async function settleNotices(
  tx: Tx,
  companyId: string,
  callNoticeIds: readonly string[],
): Promise<void> {
  for (const id of new Set(callNoticeIds)) {
    const notice = await tx.callNotice.findFirst({
      where: { id, companyId, status: "SENT" },
      select: { id: true, lines: { select: { status: true } } },
    });
    if (!notice || notice.lines.length === 0) continue;
    if (notice.lines.every((l) => l.status === "PAID")) {
      await tx.callNotice.update({
        where: { id: notice.id, companyId, status: "SENT" },
        data: { status: "SETTLED" },
      });
    }
  }
}

async function stakeholderNames(
  tx: Reader,
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.stakeholder.findMany({
    where: { companyId, id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Queries

export async function listCallNotices(
  tx: Reader,
  companyId: string,
  today: IsoDate,
) {
  const notices = await tx.callNotice.findMany({
    where: { companyId },
    orderBy: { number: "desc" },
    select: {
      id: true,
      number: true,
      kind: true,
      status: true,
      sentAt: true,
      createdAt: true,
    },
  });
  const lines = await getLineStates(tx, companyId, today);
  return notices.map((n) => {
    const own = lines.filter((l) => l.callNoticeId === n.id);
    const sent = own.filter((l) => l.status === "SENT" || l.status === "PAID");
    const dues = own
      .map((l) => l.dueOn)
      .filter((d): d is IsoDate => d !== null)
      .sort();
    return {
      id: n.id,
      number: n.number,
      kind: n.kind,
      status: n.status,
      sentAt: n.sentAt,
      createdAt: n.createdAt,
      lineCount: own.length,
      totalCalled: own.reduce((s, l) => s + l.amountCalled, 0n),
      totalOutstanding: sent.reduce(
        (s, l) => s + (l.outstanding > 0n ? l.outstanding : 0n),
        0n,
      ),
      earliestDueOn: dues[0] ?? null,
      overdueCount: own.filter((l) => l.overdue).length,
    };
  });
}

/** The wire block with the account number masked: the only form a procedure returns. */
function maskedWire(w: WireInstructions) {
  return {
    beneficiaryName: w.beneficiaryName,
    beneficiaryAddress: w.beneficiaryAddress,
    bankName: w.bankName,
    bankAddress: w.bankAddress,
    routingNumber: w.routingNumber,
    swiftCode: w.swiftCode,
    accountType: w.accountType,
    accountLast4: w.accountNumber.slice(-4),
  };
}

export async function getCallNotice(
  tx: Tx,
  companyId: string,
  today: IsoDate,
  id: string,
) {
  const notice = await tx.callNotice.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      number: true,
      kind: true,
      status: true,
      purpose: true,
      bankAccountId: true,
      sentAt: true,
      cancelledAt: true,
      cancelReason: true,
      createdAt: true,
      lines: {
        select: {
          id: true,
          status: true,
          sentAt: true,
          sentOn: true,
          sentToEmail: true,
          emailLogId: true,
          paidInFullOn: true,
          prepaidMatchedAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!notice) notFound("Call Notice");
  // For a line left in SENDING (or SEND_FAILED), the email log says whether
  // its email was in fact accepted ("Resolve" finalises it from that row).
  const unresolved = notice.lines
    .filter((l) => l.status === "SENDING" || l.status === "SEND_FAILED")
    .map((l) => l.id);
  const sentLogs = await sentEmailLogs(tx, companyId, unresolved);
  const now = Date.now();
  const states = await getLineStates(tx, companyId, today, {
    callNoticeId: notice.id,
  });
  const names = await stakeholderNames(
    tx,
    companyId,
    states.map((s) => s.stakeholderId),
  );
  const extra = new Map(notice.lines.map((l) => [l.id, l]));
  const account = notice.bankAccountId
    ? await tx.bankAccount.findFirst({
        where: { id: notice.bankAccountId, companyId },
        select: { id: true },
      })
    : null;
  const wire = account
    ? maskedWire(await getWireInstructions(tx, companyId, account.id))
    : null;
  const { lines: _lines, ...rest } = notice;
  return {
    notice: { ...rest },
    wire,
    lines: states.map((s) => {
      const e = extra.get(s.lineId);
      return {
        ...s,
        name: names.get(s.stakeholderId) ?? "",
        sentAt: e?.sentAt ?? null,
        sentOn: dateOrNull(e?.sentOn ?? null),
        sentToEmail: e?.sentToEmail ?? null,
        emailLogId: e?.emailLogId ?? null,
        paidInFullOn: dateOrNull(e?.paidInFullOn ?? null),
        /** False for a sent or paid line whose prepaid money is still to be matched ("Re-match prepaid money"). */
        prepaidMatched:
          !(s.status === "SENT" || s.status === "PAID") ||
          (e?.prepaidMatchedAt ?? null) !== null,
        /** A SENDING line older than two minutes: the Manager must resolve it. */
        sendingStale:
          s.status === "SENDING" &&
          e !== undefined &&
          now - e.updatedAt.getTime() >= SENDING_RESOLVE_AFTER_MS,
        sendingSince: s.status === "SENDING" ? (e?.updatedAt ?? null) : null,
        /** The accepted email of a SENDING / SEND_FAILED line, from the email log. */
        sentEmailLog: sentLogs.get(s.lineId) ?? null,
      };
    }),
  };
}

/** The latest SENT EmailLog row of each Call Notice line (accepted by the mail server). */
async function sentEmailLogs(
  tx: Reader,
  companyId: string,
  lineIds: readonly string[],
): Promise<Map<string, { id: string; sentAt: Date; toAddress: string }>> {
  if (lineIds.length === 0) return new Map();
  const logs = await tx.emailLog.findMany({
    where: {
      companyId,
      kind: "llc.call-notice",
      relatedType: "callNoticeLine",
      relatedId: { in: [...lineIds] },
      status: "SENT",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      relatedId: true,
      sentAt: true,
      createdAt: true,
      toAddress: true,
    },
  });
  const out = new Map<
    string,
    { id: string; sentAt: Date; toAddress: string }
  >();
  for (const l of logs) {
    if (l.relatedId === null || out.has(l.relatedId)) continue;
    out.set(l.relatedId, {
      id: l.id,
      sentAt: l.sentAt ?? l.createdAt,
      toAddress: l.toAddress,
    });
  }
  return out;
}

export async function getEligible(
  tx: Tx,
  company: { id: string; timezone: string },
) {
  const { config, today } = await getEconomicsContext(tx, company);
  const states = await getCommitmentStates(tx, company.id);
  const outsideDate = config.balanceOutsideDate;
  let proposedDueOn: IsoDate | null = null;
  if (outsideDate !== null && today <= outsideDate) {
    proposedDueOn = callNoticeDueDate(today, config);
  }
  const accounts = await tx.bankAccount.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, bankName: true, accountNumber: true, primary: true },
  });
  return {
    states,
    outsideDate,
    today,
    proposedDueOn,
    bankAccounts: accounts.map((a) => ({
      id: a.id,
      bankName: a.bankName,
      last4: a.accountNumber.slice(-4),
      primary: a.primary,
    })),
    sendBlockedReason: sendBlockedReason({
      nodeEnv: process.env.NODE_ENV,
      mailCatcher: isMailCatcherConfigured(),
    }),
    /** The settings-dependent wording of the notice (the send dialog repeats it). */
    noticeTerms: noticeTermsText(config),
  };
}

export async function getOverdueLines(
  tx: Tx,
  company: { id: string; timezone: string },
) {
  const { config, today } = await getEconomicsContext(tx, company);
  const overdue = (await getLineStates(tx, company.id, today)).filter(
    (l) => l.overdue,
  );
  const names = await stakeholderNames(
    tx,
    company.id,
    overdue.map((l) => l.stakeholderId),
  );
  return overdue.map((l) => ({
    ...l,
    name: names.get(l.stakeholderId) ?? "",
    forfeitureDate: l.dueOn === null ? null : forfeitureDate(l.dueOn, config),
  }));
}

// ---------------------------------------------------------------------------
// Email

interface NoticeEmailInput {
  companyName: string;
  noticeNumber: number;
  purpose: string | null;
  state: CommitmentState;
  amountCalled: Cents;
  alreadyReceived: Cents;
  sentOn: IsoDate;
  dueOn: IsoDate;
  outsideDate: IsoDate;
  /** Full account number only for an email actually sent; masked otherwise. */
  wire: WireInstructions;
  manager: { name: string; email: string };
  isOutsideDate: boolean;
  /** The settings-dependent wording (noticeTermsText of the config). */
  terms: NoticeTermsText;
}

async function renderNoticeEmail(
  i: NoticeEmailInput,
): Promise<{ subject: string; html: string }> {
  const amounts = formatNoticeAmounts(
    noticeAmounts({
      committed: i.state.acceptedCents,
      paidToDate: i.state.totalPaid,
      uncalledBefore: i.state.uncalled,
      amountCalled: i.amountCalled,
      alreadyReceived: i.alreadyReceived,
    }),
  );
  const dueOnLong = longDate(i.dueOn);
  const html = await render(
    CallNoticeEmail({
      companyName: i.companyName,
      memberName: i.state.name,
      noticeNumber: String(i.noticeNumber),
      sentOnLong: longDate(i.sentOn),
      dueOnLong,
      outsideDateLong: calendarDate(i.outsideDate),
      ...amounts,
      purpose: i.purpose ?? "",
      wire: {
        beneficiaryName: i.wire.beneficiaryName,
        beneficiaryAddress: i.wire.beneficiaryAddress,
        bankName: i.wire.bankName,
        bankAddress: i.wire.bankAddress,
        routingNumber: i.wire.routingNumber,
        accountNumber: i.wire.accountNumber,
        swiftCode: i.wire.swiftCode ?? "",
      },
      reference: callNoticeReference(
        i.companyName,
        i.noticeNumber,
        i.state.name,
      ),
      managerName: i.manager.name,
      managerEmail: i.manager.email,
      isOutsideDate: i.isOutsideDate,
      ...i.terms,
    }),
  );
  return {
    subject: callNoticeSubject({
      noticeNumber: i.noticeNumber,
      companyName: i.companyName,
      amountDue: amounts.amountDue,
      dueOnLong,
    }),
    html,
  };
}

/** `{ subject, html, dueOn }` of a line's email as if sent now, with the account number masked. */
export async function previewCallNotice(
  tx: Tx,
  i: {
    company: { id: string; name: string; timezone: string };
    id: string;
    commitmentId: string;
    manager: { name: string; email: string };
  },
): Promise<{ subject: string; html: string; dueOn: IsoDate }> {
  const companyId = i.company.id;
  const notice = await tx.callNotice.findFirst({
    where: { id: i.id, companyId },
  });
  if (!notice) notFound("Call Notice");
  const line = await tx.callNoticeLine.findFirst({
    where: { companyId, callNoticeId: notice.id, commitmentId: i.commitmentId },
  });
  if (!line) notFound("Call Notice line");
  if (line.status === "SENDING") {
    ruleViolation("This line is being sent; its email is in the email log.");
  }
  if (!SENDABLE.includes(line.status)) {
    ruleViolation(
      "This line has already been sent; its email is in the email log.",
    );
  }
  if (notice.bankAccountId === null) {
    ruleViolation(
      "Choose the bank account whose wire instructions the notice prints.",
    );
  }
  const { config, today } = await getEconomicsContext(tx, i.company);
  const outside = requireOutsideDate(config);
  const dueOn = dueDateFor(today, config);
  const [state] = await getCommitmentStates(tx, companyId, {
    commitmentIds: [line.commitmentId],
  });
  if (!state) {
    ruleViolation(
      "The commitment is no longer an accepted Preferred commitment.",
    );
  }
  const match = planPrepaidMatch({
    lineAmount: line.amountCalledCents,
    dueOn,
    rule: config.balanceReturnStartRule,
    prepaidReceipts: await loadPrepaidReceipts(
      tx,
      companyId,
      line.commitmentId,
    ),
  });
  const wire = await getWireInstructions(tx, companyId, notice.bankAccountId);
  const { subject, html } = await renderNoticeEmail({
    companyName: i.company.name,
    noticeNumber: notice.number,
    purpose: notice.purpose,
    state,
    amountCalled: line.amountCalledCents,
    alreadyReceived: match.total,
    sentOn: today,
    dueOn,
    outsideDate: outside,
    wire: { ...wire, accountNumber: maskedAccountNumber(wire.accountNumber) },
    manager: i.manager,
    isOutsideDate: notice.kind === "OUTSIDE_DATE",
    terms: noticeTermsText(config),
  });
  return { subject, html, dueOn };
}

// ---------------------------------------------------------------------------
// Drafts

export async function saveCallNoticeDraft(
  tx: Tx,
  i: {
    companyId: string;
    actor: LedgerActor;
    id?: string;
    purpose?: string;
    bankAccountId: string;
    lines: { commitmentId: string; amountCalledCents: Cents }[];
  },
): Promise<{ id: string; number: number }> {
  const { companyId, actor } = i;
  await lockCompanyLedger(tx, companyId);
  // Under the lock: a draft is edited only while none of its lines has left
  // UNSENT (a SENDING or SENT line's email may have gone out). Every change
  // away from UNSENT happens under this lock, so the check holds for the rest
  // of the transaction.
  const existing = i.id
    ? await tx.callNotice.findFirst({
        where: { id: i.id, companyId },
        select: {
          id: true,
          number: true,
          status: true,
          lines: { select: { id: true, status: true } },
        },
      })
    : null;
  if (i.id) {
    if (!existing) notFound("Call Notice");
    if (existing.status !== "DRAFT") {
      ruleViolation("Only a draft Call Notice can be edited.");
    }
    if (existing.lines.some((l) => l.status !== "UNSENT")) {
      conflict(
        "This Call Notice is being sent or was sent to some members; it can no longer be edited.",
      );
    }
  }
  const account = await tx.bankAccount.findFirst({
    where: { id: i.bankAccountId, companyId },
    select: { id: true },
  });
  if (!account) notFound("Bank account");
  await assertCompanyOwns(
    tx,
    companyId,
    { commitmentIds: i.lines.map((l) => l.commitmentId) },
    () => notFound("Commitment"),
  );
  const states = new Map(
    (
      await getCommitmentStates(tx, companyId, {
        commitmentIds: i.lines.map((l) => l.commitmentId),
      })
    ).map((s) => [s.commitmentId, s]),
  );
  const rows = i.lines.map((l) => {
    const state = states.get(l.commitmentId);
    if (!state) {
      ruleViolation(
        "A Call Notice can call only the Balance of an accepted Preferred commitment (Section 4.9).",
      );
    }
    if (l.amountCalledCents > state.uncalled) {
      ruleViolation(
        `${state.name}: ${formatCents(l.amountCalledCents)} is more than the uncalled Balance of ${formatCents(state.uncalled)} (Section 4.9).`,
      );
    }
    return { state, amount: l.amountCalledCents };
  });
  const purpose = i.purpose?.trim() ? i.purpose.trim() : null;
  const total = rows.reduce((s, r) => s + r.amount, 0n);

  let notice: { id: string; number: number };
  let action: AuditSchemaType["action"];
  if (existing) {
    await tx.callNotice.update({
      where: { id: existing.id, companyId },
      data: { purpose, bankAccountId: account.id },
    });
    // Line by line with the guard in `where` (P2025 if a line left UNSENT):
    // never `deleteMany`, which under relationMode "prisma" deletes children
    // by pre-selected ids before a guarded parent delete. The lines were
    // re-read under the lock above and are all UNSENT (no allocations, no
    // default).
    for (const l of existing.lines) {
      try {
        await tx.callNoticeLine.delete({
          where: { id: l.id, companyId, status: "UNSENT" },
        });
      } catch (error) {
        if (isRecordNotFound(error)) {
          conflict(
            "This Call Notice is being sent or was sent to some members; it can no longer be edited.",
          );
        }
        throw error;
      }
    }
    notice = { id: existing.id, number: existing.number };
    action = "callNotice.updated";
  } else {
    notice = await tx.callNotice.create({
      data: {
        companyId,
        number: await nextNoticeNumber(tx, companyId),
        kind: "CALL",
        status: "DRAFT",
        purpose,
        bankAccountId: account.id,
        createdById: createdBy(actor),
      },
      select: { id: true, number: true },
    });
    action = "callNotice.created";
  }
  await tx.callNoticeLine.createMany({
    data: rows.map((r) => ({
      companyId,
      callNoticeId: notice.id,
      stakeholderId: r.state.stakeholderId,
      commitmentId: r.state.commitmentId,
      amountCalledCents: r.amount,
    })),
  });
  await audit(
    tx,
    actor,
    companyId,
    action,
    [{ type: "callNotice", id: notice.id }],
    `${actor.name} ${action === "callNotice.created" ? "created" : "updated"} draft Call Notice No. ${notice.number}: ${rows.length} member${rows.length === 1 ? "" : "s"}, ${formatCents(total)} called.`,
  );
  return notice;
}

export async function cancelCallNoticeDraft(
  tx: Tx,
  i: { companyId: string; actor: LedgerActor; id: string; reason: string },
): Promise<void> {
  const { companyId, actor } = i;
  await lockCompanyLedger(tx, companyId);
  const notice = await tx.callNotice.findFirst({
    where: { id: i.id, companyId },
    select: {
      id: true,
      number: true,
      status: true,
      lines: { select: { status: true } },
    },
  });
  if (!notice) notFound("Call Notice");
  if (notice.status !== "DRAFT") {
    ruleViolation("Only a draft Call Notice can be cancelled.");
  }
  // Under the lock: a line that left UNSENT may have been emailed (SENDING,
  // SENT) or needs review (SEND_FAILED); such a notice is not a mere draft.
  if (notice.lines.some((l) => l.status !== "UNSENT")) {
    conflict(
      "This Call Notice is being sent or was sent to some members; it can no longer be cancelled.",
    );
  }
  await tx.callNotice.update({
    where: { id: notice.id, companyId, status: "DRAFT" },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelReason: i.reason,
    },
  });
  await audit(
    tx,
    actor,
    companyId,
    "callNotice.cancelled",
    [{ type: "callNotice", id: notice.id }],
    `${actor.name} cancelled draft Call Notice No. ${notice.number}: ${i.reason}`,
  );
}

// ---------------------------------------------------------------------------
// Prepaid matching (after an accepted send, outside-date notice, reconcile)

/**
 * Why matching `match` must not happen now, or null. A matched slice
 * accrues Preferred Return from its slice start instead of the receipt's
 * stored start, so accrual changes from the earlier of the two dates; that
 * is refused, like a receipt dated then (`receiptDateBlocker`), when a
 * finalized distribution was paid on or after it (its frozen unpaid return
 * would no longer replay), the books are closed through it, or a confirmed
 * forfeiture of the member is effective on or after it. Units do not
 * change, so confirmed credits do not matter here.
 */
async function prepaidMatchBlocker(
  tx: Tx,
  companyId: string,
  commitmentId: string,
  match: PrepaidMatch,
  receipts: readonly {
    receiptId: string;
    prefReturnStartDate: IsoDate | null;
  }[],
): Promise<string | null> {
  const startOf = new Map(
    receipts.map((r) => [r.receiptId, r.prefReturnStartDate]),
  );
  let from: IsoDate | null = null;
  let movedTo: IsoDate | null = null;
  for (const a of match.allocations) {
    // No stored start: the class has no Preferred Return, nothing accrues.
    const old = startOf.get(a.receiptId) ?? null;
    if (old === null || old === a.prefReturnStartOn) continue;
    const earlier = minIso(old, a.prefReturnStartOn);
    if (from === null || earlier < from) {
      from = earlier;
      movedTo = a.prefReturnStartOn;
    }
  }
  if (from === null || movedTo === null) return null;
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, companyId },
    select: { stakeholderId: true, unitClassId: true },
  });
  if (!commitment) notFound("Commitment");
  const blocked = await receiptDateBlocker(
    tx,
    companyId,
    from,
    {},
    {
      stakeholderId: commitment.stakeholderId,
      unitClassId: commitment.unitClassId,
    },
    { unitsChange: false },
  );
  return blocked === null
    ? null
    : `Matching the ${formatCents(match.total)} of Balance money already received to this line would make its Preferred Return accrue from ${formatDateOnly(movedTo)} (it now accrues from a different date), which changes figures already frozen: ${blocked}`;
}

/** Allocates the member's prepaid Balance money to a sent line; returns the amount matched. */
async function matchPrepaid(
  tx: Tx,
  i: {
    companyId: string;
    actor: LedgerActor;
    lineId: string;
    commitmentId: string;
    lineAmount: Cents;
    dueOn: IsoDate;
    rule: LlcEconomicsConfig["balanceReturnStartRule"];
  },
): Promise<Cents> {
  const receipts = await loadPrepaidReceipts(tx, i.companyId, i.commitmentId);
  const match = planPrepaidMatch({
    lineAmount: i.lineAmount,
    dueOn: i.dueOn,
    rule: i.rule,
    prepaidReceipts: receipts,
  });
  // Callers that must not throw (a reconcile after a send) check first.
  const blocked = await prepaidMatchBlocker(
    tx,
    i.companyId,
    i.commitmentId,
    match,
    receipts,
  );
  if (blocked !== null) ruleViolation(blocked);
  for (const a of match.allocations) {
    await tx.callNoticeAllocation.create({
      data: {
        companyId: i.companyId,
        callNoticeLineId: i.lineId,
        capitalReceiptId: a.receiptId,
        amountCents: a.amount,
        receivedOn: fromDateOnly(a.receivedOn),
        prefReturnStartOn: fromDateOnly(a.prefReturnStartOn),
        source: "PREPAID",
        createdById: createdBy(i.actor),
      },
    });
  }
  // Under LATER_OF_RECEIPT_AND_DUE a receipt now wholly matched to this line
  // starts on the slice start, so FOUNDATION's pages show the same date.
  const current = new Map(
    receipts.map((r) => [r.receiptId, r.prefReturnStartDate]),
  );
  for (const s of match.setStartReceipts) {
    if (current.get(s.receiptId) === s.startDate) continue;
    await setReceiptPrefReturnStart(
      tx,
      {
        companyId: i.companyId,
        receiptId: s.receiptId,
        startDate: s.startDate,
      },
      i.actor,
    );
  }
  return match.total;
}

/** amountCalled − Σ net allocations − Σ fundings of the line's default. */
async function lineOutstanding(
  tx: Tx,
  companyId: string,
  line: { id: string; amountCalledCents: Cents },
): Promise<Cents> {
  const allocated = await tx.callNoticeAllocation.aggregate({
    where: { companyId, callNoticeLineId: line.id },
    _sum: { amountCents: true },
  });
  const memberDefault = await tx.memberDefault.findFirst({
    where: { companyId, callNoticeLineId: line.id },
    select: { id: true },
  });
  const funded = memberDefault
    ? await tx.memberDefaultFunding.aggregate({
        where: { companyId, memberDefaultId: memberDefault.id },
        _sum: { amountCents: true },
      })
    : null;
  return (
    line.amountCalledCents -
    (allocated._sum.amountCents ?? 0n) -
    (funded?._sum.amountCents ?? 0n)
  );
}

/**
 * Matches prepaid money to one SENT or PAID line whose `prepaidMatchedAt` is
 * null, marks it PAID when covered, settles its notice and sets the marker.
 * The caller holds `lockLedgerAndPreferred`. Returns the line's status after.
 *
 * When the match would change frozen figures (`prepaidMatchBlocker`: a
 * finalized distribution, closed books, a confirmed forfeiture) nothing is
 * written, the marker stays null and `blocked` says why: this never throws
 * away the caller's transaction. The money stays unapplied, so the member
 * cannot be declared in default on this line (`declareDefault` refuses while
 * paid Balance is unapplied) and `recordCallNoticePayment` refuses until the
 * cause is removed (e.g. the distribution reversed) and the match runs.
 */
async function reconcileLineLocked(
  tx: Tx,
  i: {
    companyId: string;
    actor: LedgerActor;
    lineId: string;
    rule: LlcEconomicsConfig["balanceReturnStartRule"];
  },
): Promise<{
  status: CallNoticeLineStatusEnum;
  matched: Cents;
  blocked?: string;
}> {
  const { companyId } = i;
  const line = await tx.callNoticeLine.findFirst({
    where: { id: i.lineId, companyId },
    include: { callNotice: { select: { number: true } } },
  });
  if (!line) notFound("Call Notice line");
  if (
    !(line.status === "SENT" || line.status === "PAID") ||
    line.prepaidMatchedAt !== null ||
    line.dueOn === null
  ) {
    return { status: line.status, matched: 0n };
  }
  const dueOn = toDateOnly(line.dueOn);
  const outstanding = await lineOutstanding(tx, companyId, line);
  if (outstanding > 0n) {
    const receipts = await loadPrepaidReceipts(
      tx,
      companyId,
      line.commitmentId,
    );
    const plan = planPrepaidMatch({
      lineAmount: outstanding,
      dueOn,
      rule: i.rule,
      prepaidReceipts: receipts,
    });
    const blocked = await prepaidMatchBlocker(
      tx,
      companyId,
      line.commitmentId,
      plan,
      receipts,
    );
    if (blocked !== null) {
      logger.warn(
        { companyId, lineId: line.id },
        "Call Notice: prepaid matching skipped, it would change frozen figures",
      );
      return {
        status: line.status,
        matched: 0n,
        blocked: `Call Notice No. ${line.callNotice.number}: ${blocked}`,
      };
    }
  }
  const matched =
    outstanding > 0n
      ? await matchPrepaid(tx, {
          companyId,
          actor: i.actor,
          lineId: line.id,
          commitmentId: line.commitmentId,
          lineAmount: outstanding,
          dueOn,
          rule: i.rule,
        })
      : 0n;
  const paid = line.status === "SENT" && matched > 0n && matched >= outstanding;
  const paidOn = line.sentOn ?? line.dueOn;
  await tx.callNoticeLine.update({
    where: { id: line.id, companyId, prepaidMatchedAt: null },
    data: {
      prepaidMatchedAt: new Date(),
      ...(paid ? { status: "PAID", paidInFullOn: paidOn } : {}),
    },
  });
  if (paid) await settleNotices(tx, companyId, [line.callNoticeId]);
  if (matched > 0n) {
    await audit(
      tx,
      i.actor,
      companyId,
      "callNotice.prepaid-matched",
      [
        { type: "callNotice", id: line.callNoticeId },
        { type: "stakeholder", id: line.stakeholderId },
        { type: "commitment", id: line.commitmentId },
      ],
      `${formatCents(matched)} of Balance money already received was matched to Call Notice No. ${line.callNotice.number} (due ${dueOn})${paid ? "; the line is paid in full" : ""}.`,
    );
  }
  return { status: paid ? "PAID" : line.status, matched };
}

/**
 * Matches prepaid money to every SENT or PAID line not yet matched
 * (`prepaidMatchedAt` null), oldest notice first, under the advisory lock and
 * the Preferred unit-class lock. Runs at the start of `recordCallNoticePayment`
 * (so a payment never goes ahead of money received earlier) and from the
 * "Re-match prepaid money" action.
 */
export async function reconcileCallNoticeLines(
  tx: Tx,
  companyId: string,
  commitmentId: string | undefined,
  actor: LedgerActor,
): Promise<
  {
    lineId: string;
    matched: Cents;
    status: CallNoticeLineStatusEnum;
    /** Set when the match was skipped (see `reconcileLineLocked`). */
    blocked?: string;
  }[]
> {
  const locked = await lockLedgerAndPreferred(tx, companyId);
  if (!locked) return [];
  const lines = await tx.callNoticeLine.findMany({
    where: {
      companyId,
      ...(commitmentId ? { commitmentId } : {}),
      status: { in: ["SENT", "PAID"] },
      prepaidMatchedAt: null,
    },
    orderBy: [
      { callNotice: { number: "asc" } },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: { id: true },
  });
  const out: {
    lineId: string;
    matched: Cents;
    status: CallNoticeLineStatusEnum;
    blocked?: string;
  }[] = [];
  for (const l of lines) {
    const r = await reconcileLineLocked(tx, {
      companyId,
      actor,
      lineId: l.id,
      rule: locked.rule,
    });
    out.push({ lineId: l.id, ...r });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Send

export type SendLineResult = {
  lineId: string;
  ok: boolean;
  /** True whenever the mail server accepted the email (such a line must never be sent again). */
  emailSent: boolean;
  /** The line's status after this call; "Retry failed" retries only SEND_FAILED. */
  status: CallNoticeLineStatusEnum;
  /** The due date printed in this line's email (absent when nothing was sent). */
  dueOn?: IsoDate;
  error?: string;
  emailLogId?: string | null;
};

type ReservedLine = {
  lineId: string;
  stakeholderId: string;
  commitmentId: string;
  amountCalled: Cents;
  state: CommitmentState;
  to: string;
  alreadyReceived: Cents;
};

/** SENDING → SEND_FAILED when the line is still SENDING; returns the status after. */
async function markSendFailed(
  db: TPrisma,
  companyId: string,
  lineId: string,
): Promise<CallNoticeLineStatusEnum> {
  try {
    await db.callNoticeLine.update({
      where: { id: lineId, companyId, status: "SENDING" },
      data: { status: "SEND_FAILED" },
    });
    return "SEND_FAILED";
  } catch (error) {
    if (!isRecordNotFound(error)) {
      logger.error(
        { err: error, companyId, lineId },
        "Call Notice: could not mark the line SEND_FAILED",
      );
    }
    const line = await db.callNoticeLine
      .findFirst({ where: { id: lineId, companyId }, select: { status: true } })
      .catch(() => null);
    return line?.status ?? "SENDING";
  }
}

/**
 * R26, R28. (A) Reserves the target lines (SENDING) in one locked
 * transaction after every check; (B) renders each email just before sending
 * it and sends it (in order of member name); (C) records each accepted email
 * (SENDING → SENT, no lock, no re-check) and then matches prepaid money in a
 * separate locked transaction. A failed send marks the line SEND_FAILED.
 */
export async function sendCallNotice(
  db: TPrisma,
  i: {
    company: { id: string; name: string; timezone: string };
    actor: LedgerActor;
    manager: { name: string; email: string };
    id: string;
    expectedDueOn: IsoDate;
    lineIds?: readonly string[];
  },
): Promise<{ results: SendLineResult[]; dueOn: IsoDate }> {
  const companyId = i.company.id;

  // (A) Validate and reserve, under the advisory and unit-class locks.
  const reserved = await db.$transaction(async (tx) => {
    await lockLedgerAndPreferred(tx, companyId);
    const notice = await tx.callNotice.findFirst({
      where: { id: i.id, companyId },
      include: { lines: true },
    });
    if (!notice) notFound("Call Notice");
    if (notice.kind !== "CALL") {
      ruleViolation("A Balance-due record is not sent by email.");
    }
    if (notice.status === "CANCELLED") {
      ruleViolation("This Call Notice was cancelled; it cannot be sent.");
    }
    const blocked = sendBlockedReason({
      nodeEnv: process.env.NODE_ENV,
      mailCatcher: isMailCatcherConfigured(),
    });
    if (blocked) ruleViolation(blocked);
    const { config, today } = await getEconomicsContext(tx, i.company);
    const outside = requireOutsideDate(config);
    if (today > outside) {
      ruleViolation(
        "The Balance is already due under Section 4.9 (March 31, 2027); use 'Record Balance due' instead.",
      );
    }
    if (notice.bankAccountId === null) {
      ruleViolation(
        "Choose the bank account whose wire instructions the notice prints.",
      );
    }
    const wire = await getWireInstructions(tx, companyId, notice.bankAccountId);

    // Re-read under the lock: every target must still be sendable.
    let targets = notice.lines.filter((l) => SENDABLE.includes(l.status));
    if (i.lineIds) {
      const wanted = new Set(i.lineIds);
      targets = notice.lines.filter((l) => wanted.has(l.id));
      if (targets.length !== wanted.size) notFound("Call Notice line");
      if (targets.some((l) => !SENDABLE.includes(l.status))) {
        conflict(
          "Some of these lines are being sent or were already sent; refresh the page. Nothing was emailed.",
        );
      }
    } else if (
      targets.length === 0 &&
      notice.lines.some((l) => l.status === "SENDING")
    ) {
      conflict(
        "This Call Notice is being sent right now; refresh the page. Nothing was emailed.",
      );
    }
    if (targets.length === 0) {
      ruleViolation("This Call Notice has no lines left to send.");
    }
    // A failed line whose email the log shows as accepted must not be sent
    // a second time (it is resolved on the notice page instead).
    const logs = await sentEmailLogs(
      tx,
      companyId,
      targets.filter((l) => l.status === "SEND_FAILED").map((l) => l.id),
    );
    if (logs.size > 0) {
      conflict(
        "The email log shows the notice to some of these members was already accepted by the mail server; resolve those lines on the notice page. Nothing was emailed.",
      );
    }

    // Counts every SENDING, SENT and PAID line of every notice; the targets
    // themselves are not counted (they are UNSENT or SEND_FAILED).
    const states = new Map(
      (
        await getCommitmentStates(tx, companyId, {
          commitmentIds: targets.map((l) => l.commitmentId),
        })
      ).map((s) => [s.commitmentId, s]),
    );
    const checked = targets.map((line) => {
      const state = states.get(line.commitmentId);
      if (!state) {
        ruleViolation(
          "A line's commitment is no longer an accepted Preferred commitment; edit the draft.",
        );
      }
      if (state.noticeEmail === null) {
        ruleViolation(
          `${state.name} has no email address on Exhibit A; a Call Notice is effective only when sent by email (Section 4.9).`,
        );
      }
      if (line.amountCalledCents > state.uncalled) {
        ruleViolation(
          `${state.name}: ${formatCents(line.amountCalledCents)} is more than the uncalled Balance of ${formatCents(state.uncalled)} (Section 4.9).`,
        );
      }
      return { line, state, to: state.noticeEmail };
    });

    const dueOn = dueDateFor(today, config);
    if (dueOn !== i.expectedDueOn) {
      conflict(
        `The due date changed to ${formatDateOnly(dueOn)}; review and confirm again.`,
      );
    }

    const items: ReservedLine[] = [];
    for (const { line, state, to } of checked.sort((a, b) =>
      byName(a.state, b.state),
    )) {
      const prepaid = await loadPrepaidReceipts(
        tx,
        companyId,
        line.commitmentId,
      );
      const match = planPrepaidMatch({
        lineAmount: line.amountCalledCents,
        dueOn,
        rule: config.balanceReturnStartRule,
        prepaidReceipts: prepaid,
      });
      // The notice is effective once the email leaves and the match runs
      // after that, so a match that would change frozen figures is refused
      // here, before anything is emailed. A later due date (day rollover,
      // `finalDueOn`) only moves the slice start later, never earlier.
      const blocked = await prepaidMatchBlocker(
        tx,
        companyId,
        line.commitmentId,
        match,
        prepaid,
      );
      if (blocked !== null) {
        ruleViolation(`${state.name}: ${blocked} Nothing was emailed.`);
      }
      try {
        await tx.callNoticeLine.update({
          where: { id: line.id, companyId, status: { in: SENDABLE } },
          data: { status: "SENDING", dueOn: fromDateOnly(dueOn) },
        });
      } catch (error) {
        if (isRecordNotFound(error)) {
          conflict(
            "Some of these lines are being sent or were already sent; refresh the page. Nothing was emailed.",
          );
        }
        throw error;
      }
      items.push({
        lineId: line.id,
        stakeholderId: line.stakeholderId,
        commitmentId: line.commitmentId,
        amountCalled: line.amountCalledCents,
        state,
        to,
        alreadyReceived: match.total,
      });
    }
    return {
      items,
      wire,
      config,
      today,
      outside,
      dueOn,
      number: notice.number,
      purpose: notice.purpose,
    };
  }, SEND_TX);

  const terms = noticeTermsText(reserved.config);
  const results: SendLineResult[] = [];
  for (const item of reserved.items) {
    // (B) Render just before sending, with the due date of the day the email
    // goes out; if the day rolled over while rendering, render again.
    let day = economicsToday(i.company.timezone);
    let dueOn = reserved.dueOn;
    let email: { subject: string; html: string };
    try {
      for (;;) {
        dueOn =
          day === reserved.today
            ? reserved.dueOn
            : dueDateFor(day, reserved.config);
        email = await renderNoticeEmail({
          companyName: i.company.name,
          noticeNumber: reserved.number,
          purpose: reserved.purpose,
          state: item.state,
          amountCalled: item.amountCalled,
          alreadyReceived: item.alreadyReceived,
          sentOn: day,
          dueOn,
          outsideDate: reserved.outside,
          wire: reserved.wire,
          manager: i.manager,
          isOutsideDate: false,
          terms,
        });
        const now = economicsToday(i.company.timezone);
        if (now === day) break;
        day = now;
      }
      if (dueOn !== reserved.dueOn) {
        await db.callNoticeLine.update({
          where: { id: item.lineId, companyId, status: "SENDING" },
          data: { dueOn: fromDateOnly(dueOn) },
        });
      }
    } catch (error) {
      logger.error(
        { err: error, companyId, lineId: item.lineId },
        "Call Notice: the email could not be prepared",
      );
      const status = await markSendFailed(db, companyId, item.lineId);
      results.push({
        lineId: item.lineId,
        ok: false,
        emailSent: false,
        status,
        error: error instanceof TRPCError ? error.message : PREPARE_FAILED_TEXT,
      });
      continue;
    }

    let sent: { emailLogId: string | null; sentAt: Date };
    try {
      sent = await sendMail(
        {
          to: item.to,
          subject: email.subject,
          html: email.html,
          headers: { "X-From-Name": i.company.name },
        },
        {
          kind: "llc.call-notice",
          companyId,
          stakeholderId: item.stakeholderId,
          relatedType: "callNoticeLine",
          relatedId: item.lineId,
        },
      );
    } catch (error) {
      logger.warn(
        { err: error, companyId, lineId: item.lineId },
        "Call Notice: the mail server did not accept the email",
      );
      const status = await markSendFailed(db, companyId, item.lineId);
      results.push({
        lineId: item.lineId,
        ok: false,
        emailSent: false,
        status,
        error: SEND_FAILED_TEXT,
      });
      continue;
    }

    // (C1) The email was accepted: the notice is legally sent. Record it in a
    // small write that takes no lock and re-checks nothing.
    const sentOn = economicsToday(i.company.timezone, sent.sentAt);
    const due = finalDueOn(dueOn, sentOn, reserved.config);
    try {
      await db.$transaction(async (tx) => {
        await tx.callNoticeLine.update({
          where: { id: item.lineId, companyId, status: "SENDING" },
          data: {
            status: "SENT",
            sentAt: sent.sentAt,
            sentOn: fromDateOnly(sentOn),
            dueOn: fromDateOnly(due),
            sentToEmail: item.to,
            emailLogId: sent.emailLogId,
          },
        });
        await tx.$executeRaw`
          UPDATE "CallNotice"
          SET "status" = 'SENT', "sentAt" = ${sent.sentAt}, "updatedAt" = ${new Date()}
          WHERE "id" = ${i.id} AND "companyId" = ${companyId} AND "status" = 'DRAFT'`;
        await audit(
          tx,
          i.actor,
          companyId,
          "callNotice.sent",
          [
            { type: "callNotice", id: i.id },
            { type: "stakeholder", id: item.stakeholderId },
            { type: "commitment", id: item.commitmentId },
          ],
          `${i.actor.name} sent Call Notice No. ${reserved.number} to ${item.state.name} (${item.to}): ${formatCents(item.amountCalled)} called, due ${due}.`,
        );
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          companyId,
          lineId: item.lineId,
          emailLogId: sent.emailLogId,
        },
        "Call Notice: the email was accepted but the line could not be recorded as sent",
      );
      results.push({
        lineId: item.lineId,
        ok: false,
        emailSent: true,
        status: "SENDING",
        dueOn: due,
        emailLogId: sent.emailLogId,
        error: RECORD_FAILED_TEXT,
      });
      continue;
    }

    // (C2) Match prepaid money in its own locked transaction. On failure the
    // marker stays null and reconcileCallNoticeLines finishes it later.
    try {
      const { status, blocked } = await db.$transaction(async (tx) => {
        // Fail fast (and leave the marker null) rather than keep the send
        // request waiting behind a long-held ledger lock: Prisma's own
        // timeout does not cancel a statement blocked on a lock.
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8s'");
        const locked = await lockLedgerAndPreferred(tx, companyId);
        if (!locked) throw new Error("The Preferred unit class is missing.");
        return await reconcileLineLocked(tx, {
          companyId,
          actor: i.actor,
          lineId: item.lineId,
          rule: locked.rule,
        });
      }, MATCH_TX);
      results.push({
        lineId: item.lineId,
        ok: blocked === undefined,
        emailSent: true,
        status,
        dueOn: due,
        emailLogId: sent.emailLogId,
        ...(blocked !== undefined
          ? {
              error: `The email was sent and the line is recorded as sent, but the money already received was not matched to it. Do not resend. ${blocked}`,
            }
          : {}),
      });
    } catch (error) {
      logger.error(
        { err: error, companyId, lineId: item.lineId },
        "Call Notice: prepaid matching after the send failed",
      );
      results.push({
        lineId: item.lineId,
        ok: false,
        emailSent: true,
        status: "SENT",
        dueOn: due,
        emailLogId: sent.emailLogId,
        error: MATCH_FAILED_TEXT,
      });
    }
  }
  return { results, dueOn: reserved.dueOn };
}

// ---------------------------------------------------------------------------
// A line left in SENDING (R26: never flipped automatically)

export type ResolveSendingAction = "RESOLVE" | "MARK_SENT" | "MARK_NOT_SENT";

/**
 * Resolves a line left in SENDING (or a SEND_FAILED line whose email the log
 * shows as accepted), at least two minutes after its send started:
 * - RESOLVE: the email log shows the email was accepted → finalise as a send
 *   (SENT with the log's time and address, then prepaid matching);
 * - MARK_SENT (no such log row): the Manager confirms it was sent on `sentOn`;
 * - MARK_NOT_SENT (no such log row): back to SEND_FAILED, so it can be sent.
 */
export async function resolveCallNoticeSending(
  tx: Tx,
  i: {
    company: { id: string; timezone: string };
    actor: LedgerActor;
    lineId: string;
    action: ResolveSendingAction;
    sentOn?: IsoDate;
  },
): Promise<{
  status: CallNoticeLineStatusEnum;
  matched: Cents;
  blocked?: string;
}> {
  const companyId = i.company.id;
  const locked = await lockLedgerAndPreferred(tx, companyId);
  if (!locked) ruleViolation("The company has no Preferred unit class.");
  const line = await tx.callNoticeLine.findFirst({
    where: { id: i.lineId, companyId },
    include: { callNotice: { select: { id: true, number: true } } },
  });
  if (!line) notFound("Call Notice line");
  const log = (await sentEmailLogs(tx, companyId, [line.id])).get(line.id);
  if (!(line.status === "SENDING" || (line.status === "SEND_FAILED" && log))) {
    conflict(
      "Only a line shown as 'Sending' can be resolved; refresh the page.",
    );
  }
  if (
    line.status === "SENDING" &&
    Date.now() - line.updatedAt.getTime() < SENDING_RESOLVE_AFTER_MS
  ) {
    conflict(
      "This line started sending less than two minutes ago; wait and refresh the page.",
    );
  }
  const { config, today } = await getEconomicsContext(tx, i.company);
  const name =
    (await stakeholderNames(tx, companyId, [line.stakeholderId])).get(
      line.stakeholderId,
    ) ?? "";
  const target = [
    { type: "callNotice" as const, id: line.callNoticeId },
    { type: "stakeholder" as const, id: line.stakeholderId },
    { type: "commitment" as const, id: line.commitmentId },
  ];

  if (i.action === "MARK_NOT_SENT") {
    if (log) {
      ruleViolation(
        `The email log shows this notice was accepted by the mail server on ${formatDateOnly(economicsToday(i.company.timezone, log.sentAt))}; use Resolve.`,
      );
    }
    await tx.callNoticeLine.update({
      where: { id: line.id, companyId, status: "SENDING" },
      data: { status: "SEND_FAILED" },
    });
    await audit(
      tx,
      i.actor,
      companyId,
      "callNotice.send-resolved",
      target,
      `${i.actor.name} marked the Call Notice No. ${line.callNotice.number} line of ${name} as not sent (no email log shows it was accepted).`,
    );
    return { status: "SEND_FAILED", matched: 0n };
  }

  let sentAt: Date | null;
  let sentOn: IsoDate;
  let sentToEmail: string | null;
  let emailLogId: string | null;
  if (i.action === "RESOLVE") {
    if (!log) {
      ruleViolation(
        "No email log row shows this notice was accepted; choose 'Mark as sent' or 'Mark as not sent'.",
      );
    }
    sentAt = log.sentAt;
    sentOn = economicsToday(i.company.timezone, log.sentAt);
    sentToEmail = log.toAddress;
    emailLogId = log.id;
  } else {
    if (log) {
      ruleViolation(
        "The email log shows this notice was accepted by the mail server; use Resolve.",
      );
    }
    if (!i.sentOn) ruleViolation("Enter the date the notice was sent.");
    const createdOn = economicsToday(i.company.timezone, line.createdAt);
    if (i.sentOn > today || i.sentOn < createdOn) {
      ruleViolation(
        `The date sent must be between ${formatDateOnly(createdOn)} and today.`,
      );
    }
    sentAt = null;
    sentOn = i.sentOn;
    const [state] = await getCommitmentStates(tx, companyId, {
      commitmentIds: [line.commitmentId],
    });
    sentToEmail = state?.noticeEmail ?? null;
    emailLogId = null;
  }
  const printed = line.dueOn
    ? toDateOnly(line.dueOn)
    : dueDateFor(sentOn, config);
  const due = finalDueOn(printed, sentOn, config);
  await tx.callNoticeLine.update({
    where: {
      id: line.id,
      companyId,
      status: { in: ["SENDING", "SEND_FAILED"] },
    },
    data: {
      status: "SENT",
      sentAt,
      sentOn: fromDateOnly(sentOn),
      dueOn: fromDateOnly(due),
      sentToEmail,
      emailLogId,
    },
  });
  await tx.$executeRaw`
    UPDATE "CallNotice"
    SET "status" = 'SENT', "sentAt" = ${sentAt ?? fromDateOnly(sentOn)}, "updatedAt" = ${new Date()}
    WHERE "id" = ${line.callNoticeId} AND "companyId" = ${companyId} AND "status" = 'DRAFT'`;
  await audit(
    tx,
    i.actor,
    companyId,
    "callNotice.send-resolved",
    target,
    i.action === "RESOLVE"
      ? `${i.actor.name} resolved the Call Notice No. ${line.callNotice.number} line of ${name} as sent on ${sentOn} to ${sentToEmail ?? "(unknown)"} (email log ${emailLogId}), due ${due}.`
      : `${i.actor.name} confirmed the Call Notice No. ${line.callNotice.number} line of ${name} was sent on ${sentOn} (no email log row), due ${due}.`,
  );
  return await reconcileLineLocked(tx, {
    companyId,
    actor: i.actor,
    lineId: line.id,
    rule: locked.rule,
  });
}

// ---------------------------------------------------------------------------
// Balance due on the outside date (R27)

export async function createOutsideDateNotice(
  tx: Tx,
  i: { company: { id: string; timezone: string }; actor: LedgerActor },
): Promise<{ id: string; number: number; lineCount: number }> {
  const companyId = i.company.id;
  await lockLedgerAndPreferred(tx, companyId);
  // Money received before an earlier notice belongs to that notice first.
  await reconcileCallNoticeLines(tx, companyId, undefined, i.actor);
  const { config, today } = await getEconomicsContext(tx, i.company);
  const outside = requireOutsideDate(config);
  if (today < outside) {
    ruleViolation(
      `The Balance outside date (${formatDateOnly(outside)}) has not arrived; send a Call Notice instead (Section 4.9).`,
    );
  }
  const existing = await tx.callNotice.findFirst({
    where: { companyId, kind: "OUTSIDE_DATE" },
    select: { number: true },
  });
  if (existing) {
    ruleViolation(
      `The Balance due on ${formatDateOnly(outside)} was already recorded (Call Notice No. ${existing.number}).`,
    );
  }
  const states = (await getCommitmentStates(tx, companyId)).filter(
    (s) => s.uncalled > 0n,
  );
  if (states.length === 0) {
    ruleViolation("No commitment has an uncalled Balance.");
  }
  const notice = await tx.callNotice.create({
    data: {
      companyId,
      number: await nextNoticeNumber(tx, companyId),
      kind: "OUTSIDE_DATE",
      status: "SENT",
      createdById: createdBy(i.actor),
    },
    select: { id: true, number: true },
  });
  let total = 0n;
  for (const s of states) {
    const line = await tx.callNoticeLine.create({
      data: {
        companyId,
        callNoticeId: notice.id,
        stakeholderId: s.stakeholderId,
        commitmentId: s.commitmentId,
        amountCalledCents: s.uncalled,
        status: "SENT",
        dueOn: fromDateOnly(outside),
        // Matched just below, in this transaction.
        prepaidMatchedAt: new Date(),
      },
      select: { id: true },
    });
    total += s.uncalled;
    const matched = await matchPrepaid(tx, {
      companyId,
      actor: i.actor,
      lineId: line.id,
      commitmentId: s.commitmentId,
      lineAmount: s.uncalled,
      dueOn: outside,
      rule: config.balanceReturnStartRule,
    });
    if (matched >= s.uncalled) {
      await tx.callNoticeLine.update({
        where: { id: line.id, companyId },
        data: { status: "PAID", paidInFullOn: fromDateOnly(outside) },
      });
    }
  }
  await settleNotices(tx, companyId, [notice.id]);
  await audit(
    tx,
    i.actor,
    companyId,
    "callNotice.sent",
    [{ type: "callNotice", id: notice.id }],
    `${i.actor.name} recorded the Balance due on ${outside} without notice (Section 4.9) as Call Notice No. ${notice.number}: ${states.length} member${states.length === 1 ? "" : "s"}, ${formatCents(total)}.`,
  );
  return { ...notice, lineCount: states.length };
}

// ---------------------------------------------------------------------------
// Payments (R29)

export async function recordCallNoticePayment(
  tx: Tx,
  i: {
    company: { id: string; timezone: string };
    actor: LedgerActor;
    commitmentId: string;
    receivedOn: IsoDate;
    amountCents: Cents;
    reference?: string;
    note?: string;
  },
): Promise<{
  capitalReceiptId: string;
  allocations: (BalancePaymentPlan["allocations"][number] & {
    callNoticeId: string;
  })[];
  prepaid: Cents;
  late: boolean;
}> {
  const companyId = i.company.id;
  await lockLedgerAndPreferred(tx, companyId);
  await assertCompanyOwns(
    tx,
    companyId,
    { commitmentIds: [i.commitmentId] },
    () => notFound("Commitment"),
  );
  // Prepaid money not yet matched to a sent line (the match after a send
  // failed) is matched first, so this payment never goes ahead of it. A
  // match that had to be skipped (it would change frozen figures) leaves
  // that money unapplied: refuse rather than let this payment overtake it.
  const reconciled = await reconcileCallNoticeLines(
    tx,
    companyId,
    i.commitmentId,
    i.actor,
  );
  const skipped = reconciled.find((r) => r.blocked !== undefined);
  if (skipped?.blocked !== undefined) {
    ruleViolation(
      `Money this member paid earlier is not yet matched to a Call Notice, and this payment would go ahead of it. ${skipped.blocked}`,
    );
  }
  const { config, today } = await getEconomicsContext(tx, i.company);
  if (i.receivedOn > today) {
    ruleViolation("The date received cannot be in the future.");
  }
  const [state] = await getCommitmentStates(tx, companyId, {
    commitmentIds: [i.commitmentId],
  });
  if (!state) {
    ruleViolation(
      "Balance payments are recorded here for accepted Preferred commitments only.",
    );
  }
  const openDefault = await tx.memberDefault.findFirst({
    where: { companyId, commitmentId: i.commitmentId, status: "OPEN" },
    select: { id: true },
  });
  if (openDefault) {
    ruleViolation(
      "This member has an open default; record the payment on the default page.",
    );
  }
  if (i.amountCents > state.remainingCommitment) {
    ruleViolation("Exceeds the remaining commitment.");
  }

  const lines = await getLineStates(tx, companyId, today, {
    commitmentId: i.commitmentId,
  });
  // Money recorded here is a Balance payment (Section 4.9(b)). FOUNDATION
  // records it as BALANCE (`balancePayment`) or refuses with the reason (money
  // received before the acceptance date, or on it while the Initial
  // Installment is short, is Initial Installment money); it never turns it
  // into an INITIAL receipt that no line would see.
  const openLines: OpenLine[] = lines
    .map((l, createdSeq) => ({ l, createdSeq }))
    .filter(
      ({ l }) => l.status === "SENT" && l.dueOn !== null && l.outstanding > 0n,
    )
    .map(({ l, createdSeq }) => ({
      lineId: l.lineId,
      dueOn: l.dueOn,
      outstanding: l.outstanding,
      createdSeq,
    }));
  const plan = planBalancePayment({
    amount: i.amountCents,
    receivedOn: i.receivedOn,
    openLines,
    rule: config.balanceReturnStartRule,
  });
  const lineById = new Map(lines.map((l) => [l.lineId, l]));
  const firstNoticeId = plan.allocations[0]
    ? lineById.get(plan.allocations[0].lineId)?.callNoticeId
    : undefined;

  const receipt = await recordCapitalReceipt(
    tx,
    {
      companyId,
      commitmentId: i.commitmentId,
      receivedOn: i.receivedOn,
      amountCents: i.amountCents,
      reference: i.reference,
      note: i.note,
      ...(plan.receiptDueDate !== null ? { dueDate: plan.receiptDueDate } : {}),
      sourceType: "callNotice",
      ...(firstNoticeId ? { sourceId: firstNoticeId } : {}),
      balancePayment: true,
    },
    i.actor,
  );
  if (receipt.kind !== "BALANCE" || receipt.appliedCents !== i.amountCents) {
    throw new Error(
      "Ledger write did not match the Balance payment (BALANCE receipt); nothing was saved.",
    );
  }

  const allocations: (BalancePaymentPlan["allocations"][number] & {
    callNoticeId: string;
  })[] = [];
  for (const a of plan.allocations) {
    const line = lineById.get(a.lineId);
    if (!line) continue;
    await tx.callNoticeAllocation.create({
      data: {
        companyId,
        callNoticeLineId: a.lineId,
        capitalReceiptId: receipt.id,
        amountCents: a.amount,
        receivedOn: fromDateOnly(i.receivedOn),
        prefReturnStartOn: fromDateOnly(a.prefReturnStartOn),
        source: "PAYMENT",
        createdById: createdBy(i.actor),
      },
    });
    if (a.amount >= line.outstanding) {
      await tx.callNoticeLine.update({
        where: { id: a.lineId, companyId },
        data: { status: "PAID", paidInFullOn: fromDateOnly(i.receivedOn) },
      });
    }
    allocations.push({ ...a, callNoticeId: line.callNoticeId });
  }
  await settleNotices(
    tx,
    companyId,
    allocations.map((a) => a.callNoticeId),
  );
  const prepaid = plan.unallocated;
  const late = allocations.some((a) => i.receivedOn > a.dueOn);

  await audit(
    tx,
    i.actor,
    companyId,
    "callNotice.payment-recorded",
    [
      ...[...new Set(allocations.map((a) => a.callNoticeId))].map((id) => ({
        type: "callNotice" as const,
        id,
      })),
      { type: "capitalReceipt", id: receipt.id },
      { type: "commitment", id: i.commitmentId },
      { type: "stakeholder", id: state.stakeholderId },
    ],
    `${i.actor.name} recorded ${formatCents(i.amountCents)} received from ${state.name} on ${i.receivedOn}: ${
      allocations.length === 0
        ? "no open Call Notice line, held as prepaid Balance"
        : `${allocations.map((a) => `${formatCents(a.amount)} to the line due ${a.dueOn} (return from ${a.prefReturnStartOn})`).join("; ")}${prepaid > 0n ? `; ${formatCents(prepaid)} prepaid` : ""}`
    }${late ? "; received after the due date" : ""}.`,
  );

  return { capitalReceiptId: receipt.id, allocations, prepaid, late };
}
