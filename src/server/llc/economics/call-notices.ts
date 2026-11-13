import "server-only";

import type { CallNoticeLineStatusEnum } from "@prisma/client";
import { render } from "react-email";
import { CallNoticeEmail } from "@/emails/llc/CallNoticeEmail";
import { formatDateOnly, fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { LlcEconomicsConfig } from "@/lib/llc/config";
import type { IsoDate } from "@/lib/llc/dates";
import {
  callNoticeDueDate,
  forfeitureDate,
  type OpenLine,
} from "@/lib/llc/default";
import { type Cents, LlcMathError } from "@/lib/llc/money";
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
  noticeAmounts,
  type PrepaidReceipt,
  planBalancePayment,
  planPrepaidMatch,
  sendBlockedReason,
} from "./call-notices.logic";
import { economicsToday } from "./clock";
import { conflict, lockCompanyLedger, notFound, ruleViolation } from "./scope";
import { getEconomicsContext, requireOutsideDate } from "./term";

/*
 * Call Notices (R26–R29, §4.9). A Call Notice is effective when its email is
 * accepted by the mail server: the due date printed in the email is stored
 * on the line, and Balance money already received is matched to the line
 * when it is sent. Allocations are immutable (corrections are negating rows,
 * written by `beforeVoidReceipt` in receipt-guards.ts).
 */

type Tx = PrismaTransactionalClient;
type Reader = TPrismaOrTransaction;

const SENDABLE: CallNoticeLineStatusEnum[] = ["UNSENT", "SEND_FAILED"];

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
  /** The address a Call Notice goes to: Stakeholder.noticeEmail ?? email (null when blank). */
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
  /** Σ amountCalled of lines actually sent (line SENT or PAID on a SENT/SETTLED notice). */
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

  const sentLines = await tx.callNoticeLine.findMany({
    where: {
      companyId,
      commitmentId: { in: ids },
      status: { in: ["SENT", "PAID"] },
      callNotice: { status: { in: ["SENT", "SETTLED"] } },
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
    const address = (c.stakeholder.noticeEmail ?? c.stakeholder.email).trim();
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
        where: { id: notice.id, companyId },
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
          sentAt: true,
          sentOn: true,
          sentToEmail: true,
          emailLogId: true,
          paidInFullOn: true,
        },
      },
    },
  });
  if (!notice) notFound("Call Notice");
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
      };
    }),
  };
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
  if (i.id) {
    const existing = await tx.callNotice.findFirst({
      where: { id: i.id, companyId },
      select: { id: true, number: true, status: true },
    });
    if (!existing) notFound("Call Notice");
    if (existing.status !== "DRAFT") {
      ruleViolation("Only a draft Call Notice can be edited.");
    }
    await tx.callNotice.update({
      where: { id: existing.id, companyId },
      data: { purpose, bankAccountId: account.id },
    });
    await tx.callNoticeLine.deleteMany({
      where: { companyId, callNoticeId: existing.id },
    });
    notice = existing;
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
    select: { id: true, number: true, status: true },
  });
  if (!notice) notFound("Call Notice");
  if (notice.status !== "DRAFT") {
    ruleViolation("Only a draft Call Notice can be cancelled.");
  }
  await tx.callNotice.update({
    where: { id: notice.id, companyId },
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
// Prepaid matching (send step 5, outside-date notice)

/** Allocates the member's prepaid Balance money to a line just sent; returns the amount matched. */
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

// ---------------------------------------------------------------------------
// Send

export type SendLineResult = {
  lineId: string;
  ok: boolean;
  /** True whenever the mail server accepted the email (a "Retry failed" must skip it even when ok is false). */
  emailSent: boolean;
  error?: string;
  emailLogId?: string | null;
};

type PreparedLine = {
  lineId: string;
  stakeholderId: string;
  name: string;
  to: string;
  subject: string;
  html: string;
};

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

/**
 * R26, R28. Validates everything, then emails each target line (in order of
 * member name) and records each accepted email in its own locked
 * transaction: line SENT with the due date printed in the email, prepaid
 * money matched, notice SENT. A failed send marks the line SEND_FAILED.
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

  // (1)–(2) Validate everything and render every email before anything is sent.
  const prepared = await db.$transaction(async (tx) => {
    const notice = await tx.callNotice.findFirst({
      where: { id: i.id, companyId },
      include: { lines: true },
    });
    if (!notice) notFound("Call Notice");
    if (notice.kind !== "CALL") {
      ruleViolation("A Balance-due record is not sent by email.");
    }
    const sendable = notice.lines.filter((l) => SENDABLE.includes(l.status));
    if (
      !(
        notice.status === "DRAFT" ||
        (notice.status === "SENT" && sendable.length > 0)
      )
    ) {
      ruleViolation("This Call Notice has no lines left to send.");
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

    let targets = sendable;
    if (i.lineIds) {
      const wanted = new Set(i.lineIds);
      targets = notice.lines.filter((l) => wanted.has(l.id));
      if (targets.length !== wanted.size) notFound("Call Notice line");
      if (targets.some((l) => !SENDABLE.includes(l.status))) {
        ruleViolation("Only unsent or failed lines can be sent.");
      }
    }
    if (targets.length === 0) {
      ruleViolation("This Call Notice has no lines left to send.");
    }

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

    const items: {
      lineId: string;
      stakeholderId: string;
      amountCalled: Cents;
      state: CommitmentState;
      to: string;
      alreadyReceived: Cents;
    }[] = [];
    for (const { line, state, to } of checked.sort((a, b) =>
      byName(a.state, b.state),
    )) {
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
      items.push({
        lineId: line.id,
        stakeholderId: line.stakeholderId,
        amountCalled: line.amountCalledCents,
        state,
        to,
        alreadyReceived: match.total,
      });
    }
    return {
      items,
      wire,
      today,
      outside,
      dueOn,
      rule: config.balanceReturnStartRule,
      number: notice.number,
      purpose: notice.purpose,
    };
  });

  // Rendering is outside the transaction (it is slow for many recipients).
  const lines: PreparedLine[] = [];
  for (const item of prepared.items) {
    const { subject, html } = await renderNoticeEmail({
      companyName: i.company.name,
      noticeNumber: prepared.number,
      purpose: prepared.purpose,
      state: item.state,
      amountCalled: item.amountCalled,
      alreadyReceived: item.alreadyReceived,
      sentOn: prepared.today,
      dueOn: prepared.dueOn,
      outsideDate: prepared.outside,
      wire: prepared.wire,
      manager: i.manager,
      isOutsideDate: false,
    });
    lines.push({
      lineId: item.lineId,
      stakeholderId: item.stakeholderId,
      name: item.state.name,
      to: item.to,
      subject,
      html,
    });
  }

  // (3)–(5) Send, then record each accepted email.
  const results: SendLineResult[] = [];
  let anySent = false;
  for (const p of lines) {
    let sent: { emailLogId: string | null; sentAt: Date };
    try {
      sent = await sendMail(
        {
          to: p.to,
          subject: p.subject,
          html: p.html,
          headers: { "X-From-Name": i.company.name },
        },
        {
          kind: "llc.call-notice",
          companyId,
          stakeholderId: p.stakeholderId,
          relatedType: "callNoticeLine",
          relatedId: p.lineId,
        },
      );
    } catch (error) {
      await db.callNoticeLine.updateMany({
        where: { id: p.lineId, companyId, status: { in: SENDABLE } },
        data: { status: "SEND_FAILED" },
      });
      results.push({
        lineId: p.lineId,
        ok: false,
        emailSent: false,
        error: errorText(error),
      });
      continue;
    }

    anySent = true;
    const sentOn = economicsToday(i.company.timezone, sent.sentAt);
    try {
      await db.$transaction((tx) =>
        recordLineSent(tx, {
          companyId,
          actor: i.actor,
          noticeId: i.id,
          noticeNumber: prepared.number,
          lineId: p.lineId,
          name: p.name,
          to: p.to,
          sentAt: sent.sentAt,
          sentOn,
          dueOn: prepared.dueOn,
          emailLogId: sent.emailLogId,
          rule: prepared.rule,
        }),
      );
      results.push({
        lineId: p.lineId,
        ok: true,
        emailSent: true,
        emailLogId: sent.emailLogId,
      });
    } catch (error) {
      // The email was accepted, so the notice is legally sent: never mark it
      // SEND_FAILED (a retry would send a second notice with a later due
      // date). Record the send itself (best effort); prepaid money was not
      // matched to the line and needs review.
      const marked = await db.callNoticeLine
        .updateMany({
          where: { id: p.lineId, companyId, status: { in: SENDABLE } },
          data: {
            status: "SENT",
            sentAt: sent.sentAt,
            sentOn: fromDateOnly(sentOn),
            dueOn: fromDateOnly(prepared.dueOn),
            sentToEmail: p.to,
            emailLogId: sent.emailLogId,
          },
        })
        .then((r) => r.count === 1)
        .catch(() => false);
      if (marked) {
        await db.callNotice
          .updateMany({
            where: { id: i.id, companyId, status: "DRAFT" },
            data: { status: "SENT", sentAt: sent.sentAt },
          })
          .catch(() => undefined);
        await audit(
          db,
          i.actor,
          companyId,
          "callNotice.sent",
          [
            { type: "callNotice", id: i.id },
            { type: "stakeholder", id: p.stakeholderId },
          ],
          `${i.actor.name} sent Call Notice No. ${prepared.number} to ${p.name} (${p.to}), due ${prepared.dueOn}; recording the send failed (${errorText(error)}), so prepaid money was not matched to the line.`,
        ).catch(() => undefined);
      }
      results.push({
        lineId: p.lineId,
        ok: false,
        emailSent: true,
        emailLogId: sent.emailLogId,
        error: marked
          ? `The email was sent and the line is marked sent, but recording it failed (${errorText(error)}). Do not resend; prepaid money for this member was not matched to the line.`
          : `The email was sent (email log ${sent.emailLogId ?? "not written"}) but the line could not be marked sent (${errorText(error)}). Do not resend this line; ask an administrator to record it.`,
      });
    }
  }

  // (6) A notice whose lines are all PAID is settled.
  if (anySent) {
    await db.$transaction(async (tx) => {
      await lockCompanyLedger(tx, companyId);
      await settleNotices(tx, companyId, [i.id]);
    });
  }
  return { results, dueOn: prepared.dueOn };
}

async function recordLineSent(
  tx: Tx,
  i: {
    companyId: string;
    actor: LedgerActor;
    noticeId: string;
    noticeNumber: number;
    lineId: string;
    name: string;
    to: string;
    sentAt: Date;
    sentOn: IsoDate;
    dueOn: IsoDate;
    emailLogId: string | null;
    rule: LlcEconomicsConfig["balanceReturnStartRule"];
  },
): Promise<void> {
  const { companyId } = i;
  await lockCompanyLedger(tx, companyId);
  const line = await tx.callNoticeLine.findFirst({
    where: { id: i.lineId, companyId },
  });
  if (!line) notFound("Call Notice line");
  if (!SENDABLE.includes(line.status)) {
    ruleViolation("This line was already recorded as sent.");
  }
  // Re-check under the lock: the line is not yet SENT, so it is not in its
  // own commitment's calledTotal.
  const [state] = await getCommitmentStates(tx, companyId, {
    commitmentIds: [line.commitmentId],
  });
  if (!state || line.amountCalledCents > state.uncalled) {
    ruleViolation(
      `${i.name}: the amount called is more than the uncalled Balance (Section 4.9).`,
    );
  }
  await tx.callNoticeLine.update({
    where: { id: line.id, companyId },
    data: {
      status: "SENT",
      sentAt: i.sentAt,
      sentOn: fromDateOnly(i.sentOn),
      dueOn: fromDateOnly(i.dueOn),
      sentToEmail: i.to,
      emailLogId: i.emailLogId,
    },
  });
  const matched = await matchPrepaid(tx, {
    companyId,
    actor: i.actor,
    lineId: line.id,
    commitmentId: line.commitmentId,
    lineAmount: line.amountCalledCents,
    dueOn: i.dueOn,
    rule: i.rule,
  });
  if (matched >= line.amountCalledCents) {
    await tx.callNoticeLine.update({
      where: { id: line.id, companyId },
      data: { status: "PAID", paidInFullOn: fromDateOnly(i.sentOn) },
    });
  }
  await tx.callNotice.updateMany({
    where: { id: i.noticeId, companyId, status: "DRAFT" },
    data: { status: "SENT", sentAt: i.sentAt },
  });
  await audit(
    tx,
    i.actor,
    companyId,
    "callNotice.sent",
    [
      { type: "callNotice", id: i.noticeId },
      { type: "stakeholder", id: line.stakeholderId },
      { type: "commitment", id: line.commitmentId },
    ],
    `${i.actor.name} sent Call Notice No. ${i.noticeNumber} to ${i.name} (${i.to}): ${formatCents(line.amountCalledCents)} called, ${formatCents(matched)} already received, due ${i.dueOn}.`,
  );
}

// ---------------------------------------------------------------------------
// Balance due on the outside date (R27)

export async function createOutsideDateNotice(
  tx: Tx,
  i: { company: { id: string; timezone: string }; actor: LedgerActor },
): Promise<{ id: string; number: number; lineCount: number }> {
  const companyId = i.company.id;
  await lockCompanyLedger(tx, companyId);
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
  await lockCompanyLedger(tx, companyId);
  await assertCompanyOwns(
    tx,
    companyId,
    { commitmentIds: [i.commitmentId] },
    () => notFound("Commitment"),
  );
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
  // FOUNDATION derives INITIAL for money received on or before acceptance;
  // such a payment is not allocated to any line.
  const initial = state.acceptedOn !== null && i.receivedOn <= state.acceptedOn;
  const openLines: OpenLine[] = initial
    ? []
    : lines
        .map((l, createdSeq) => ({ l, createdSeq }))
        .filter(
          ({ l }) =>
            l.status === "SENT" && l.dueOn !== null && l.outstanding > 0n,
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
    },
    i.actor,
  );

  const allocations: (BalancePaymentPlan["allocations"][number] & {
    callNoticeId: string;
  })[] = [];
  if (receipt.kind === "BALANCE") {
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
  }
  const prepaid = receipt.kind === "BALANCE" ? plan.unallocated : 0n;
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
        ? receipt.kind === "BALANCE"
          ? "no open Call Notice line, held as prepaid Balance"
          : "Initial Installment"
        : `${allocations.map((a) => `${formatCents(a.amount)} to the line due ${a.dueOn} (return from ${a.prefReturnStartOn})`).join("; ")}${prepaid > 0n ? `; ${formatCents(prepaid)} prepaid` : ""}`
    }${late ? "; received after the due date" : ""}.`,
  );

  return { capitalReceiptId: receipt.id, allocations, prepaid, late };
}
