// Pure parts of the Call Notice services (R26–R29). Relative imports only:
// tested by vitest, which has no `@/` alias.

import { compareIso, type IsoDate, maxIso } from "../../../lib/llc/dates";
import {
  allocatePaymentToLines,
  type OpenLine,
  uncalledBalance,
} from "../../../lib/llc/default";
import type { Cents } from "../../../lib/llc/money";
import { formatCents } from "../../../lib/money";

export type BalanceReturnStartRule =
  | "LATER_OF_RECEIPT_AND_DUE"
  | "RECEIPT_DATE";

function maxBig(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

function minBig(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}

// ---------------------------------------------------------------------------
// Payments (R29)

export interface BalancePaymentPlan {
  allocations: {
    lineId: string;
    amount: Cents;
    prefReturnStartOn: IsoDate;
    dueOn: IsoDate;
  }[];
  unallocated: Cents;
  /** dueOn of the first (oldest) line the payment is allocated to. */
  firstDueOn: IsoDate | null;
  /** firstDueOn when unallocated = 0, else null: the dueDate passed to recordCapitalReceipt. */
  receiptDueDate: IsoDate | null;
}

/**
 * R29: a Balance payment goes to the member's open lines, oldest due date
 * first; the rest is prepaid (R28). Each slice starts per the unit class rule
 * (`max(receivedOn, dueOn)` or `receivedOn`). Only a fully allocated payment
 * passes a due date to FOUNDATION, so an unallocated remainder keeps
 * FOUNDATION's prepaid start `max(receivedOn, balanceOutsideDate)`.
 */
export function planBalancePayment(i: {
  amount: Cents;
  receivedOn: IsoDate;
  openLines: readonly OpenLine[];
  rule: BalanceReturnStartRule;
}): BalancePaymentPlan {
  const { allocations, unallocated } = allocatePaymentToLines(
    i.amount,
    i.receivedOn,
    i.openLines,
    i.rule,
  );
  const dueOf = new Map<string, IsoDate>();
  for (const line of i.openLines) {
    if (line.dueOn !== null) dueOf.set(line.lineId, line.dueOn);
  }
  const withDue = allocations.map((a) => {
    const dueOn = dueOf.get(a.lineId);
    if (dueOn === undefined) {
      throw new Error(`Line ${a.lineId} has no due date`);
    }
    return { ...a, dueOn };
  });
  const firstDueOn = withDue[0]?.dueOn ?? null;
  return {
    allocations: withDue,
    unallocated,
    firstDueOn,
    receiptDueDate: unallocated === 0n ? firstDueOn : null,
  };
}

// ---------------------------------------------------------------------------
// Prepaid matching at send (R28)

export interface PrepaidReceipt {
  receiptId: string;
  receivedOn: IsoDate;
  /** appliedCents − Σ net allocations of the receipt. */
  unallocated: Cents;
}

export interface PrepaidMatch {
  allocations: {
    receiptId: string;
    amount: Cents;
    receivedOn: IsoDate;
    prefReturnStartOn: IsoDate;
  }[];
  /** Σ allocations ("Already received toward this call"). */
  total: Cents;
  /** Receipts whose whole unallocated amount went to this line. */
  fullyAllocatedReceiptIds: string[];
  /**
   * Receipts whose FOUNDATION start date must move to the slice start
   * (`setReceiptPrefReturnStart`): the fully allocated ones under
   * LATER_OF_RECEIPT_AND_DUE; none under RECEIPT_DATE (they already start on
   * the receipt date).
   */
  setStartReceipts: { receiptId: string; startDate: IsoDate }[];
}

/**
 * R28: when a line is sent, the member's unallocated Balance money is matched
 * to it, oldest receipt first, up to the line amount. Slice start:
 * `receivedOn` under RECEIPT_DATE, else `max(receivedOn, dueOn)` (R5, R29).
 */
export function planPrepaidMatch(i: {
  lineAmount: Cents;
  dueOn: IsoDate;
  rule: BalanceReturnStartRule;
  prepaidReceipts: readonly PrepaidReceipt[];
}): PrepaidMatch {
  const ordered = i.prepaidReceipts
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.unallocated > 0n)
    .sort(
      (a, b) => compareIso(a.r.receivedOn, b.r.receivedOn) || a.index - b.index,
    )
    .map(({ r }) => r);
  let remaining = i.lineAmount > 0n ? i.lineAmount : 0n;
  const allocations: PrepaidMatch["allocations"] = [];
  const fullyAllocatedReceiptIds: string[] = [];
  const setStartReceipts: PrepaidMatch["setStartReceipts"] = [];
  for (const r of ordered) {
    if (remaining === 0n) break;
    const amount = minBig(r.unallocated, remaining);
    remaining -= amount;
    const prefReturnStartOn =
      i.rule === "RECEIPT_DATE" ? r.receivedOn : maxIso(r.receivedOn, i.dueOn);
    allocations.push({
      receiptId: r.receiptId,
      amount,
      receivedOn: r.receivedOn,
      prefReturnStartOn,
    });
    if (amount === r.unallocated) {
      fullyAllocatedReceiptIds.push(r.receiptId);
      if (i.rule === "LATER_OF_RECEIPT_AND_DUE") {
        setStartReceipts.push({
          receiptId: r.receiptId,
          startDate: prefReturnStartOn,
        });
      }
    }
  }
  const total = allocations.reduce((s, a) => s + a.amount, 0n);
  return { allocations, total, fullyAllocatedReceiptIds, setStartReceipts };
}

// ---------------------------------------------------------------------------
// Commitment and line figures

export type ReceiptKindName =
  | "INITIAL"
  | "BALANCE"
  | "REPLACEMENT"
  | "CREDIT"
  | "FORFEITURE";

export interface CommitmentFigures {
  replacementFunded: Cents;
  initialPaid: Cents;
  balance: Cents;
  calledTotal: Cents;
  uncalled: Cents;
  balancePaid: Cents;
  prepaidUnallocated: Cents;
  totalPaid: Cents;
  remainingCommitment: Cents;
}

/**
 * Figures of one commitment from its non-void receipts. `calledTotal` is
 * Σ amountCalled of its lines that were actually sent (line SENT or PAID on
 * a SENT/SETTLED notice); `netAllocated` is Σ net allocations of its BALANCE
 * receipts.
 */
export function commitmentFigures(i: {
  acceptedCents: Cents;
  receipts: readonly { kind: ReceiptKindName; appliedCents: Cents }[];
  netAllocated: Cents;
  calledTotal: Cents;
  replacementFunded: Cents;
}): CommitmentFigures {
  let initialPaid = 0n;
  let balancePaid = 0n;
  let replacementPaid = 0n;
  for (const r of i.receipts) {
    if (r.kind === "INITIAL") initialPaid += r.appliedCents;
    else if (r.kind === "BALANCE") balancePaid += r.appliedCents;
    else if (r.kind === "REPLACEMENT") replacementPaid += r.appliedCents;
  }
  // Cash applied as capital, as FOUNDATION counts it (sumCashApplied).
  const totalPaid = initialPaid + balancePaid + replacementPaid;
  return {
    replacementFunded: i.replacementFunded,
    initialPaid,
    balance: i.acceptedCents - initialPaid,
    calledTotal: i.calledTotal,
    uncalled: uncalledBalance({
      acceptedCommitment: i.acceptedCents + i.replacementFunded,
      initialPaid,
      calledTotal: i.calledTotal,
    }),
    balancePaid,
    prepaidUnallocated: maxBig(0n, balancePaid - i.netAllocated),
    totalPaid,
    remainingCommitment: maxBig(0n, i.acceptedCents - totalPaid),
  };
}

/** outstanding = amountCalled − Σ net allocations − Σ fundings; overdue = SENT, past due, money outstanding. */
export function lineFigures(i: {
  amountCalled: Cents;
  allocated: Cents;
  replacementFunded: Cents;
  status: string;
  dueOn: IsoDate | null;
  today: IsoDate;
}): { outstanding: Cents; overdue: boolean } {
  const outstanding = i.amountCalled - i.allocated - i.replacementFunded;
  const overdue =
    i.status === "SENT" &&
    i.dueOn !== null &&
    compareIso(i.dueOn, i.today) < 0 &&
    outstanding > 0n;
  return { outstanding, overdue };
}

// ---------------------------------------------------------------------------
// Email text

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** "2027-01-20" → "Wednesday, January 20, 2027" (calendar date, no time zone shift). */
export function longDate(d: IsoDate): string {
  return LONG_DATE.format(new Date(`${d}T00:00:00.000Z`));
}

const CALENDAR_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** "2027-03-31" → "March 31, 2027". */
export function calendarDate(d: IsoDate): string {
  return CALENDAR_DATE.format(new Date(`${d}T00:00:00.000Z`));
}

/** `"{companyName} CN{noticeNumber} {memberName}"`, at most 80 characters. */
export function callNoticeReference(
  companyName: string,
  noticeNumber: number,
  memberName: string,
): string {
  return `${companyName} CN${noticeNumber} ${memberName}`.slice(0, 80);
}

/** `Call Notice No. {noticeNumber} – {companyName} – {amountDue} due {dueOnLong}`. */
export function callNoticeSubject(i: {
  noticeNumber: number;
  companyName: string;
  amountDue: string;
  dueOnLong: string;
}): string {
  return `Call Notice No. ${i.noticeNumber} – ${i.companyName} – ${i.amountDue} due ${i.dueOnLong}`;
}

export interface NoticeAmounts {
  committed: Cents;
  paidToDate: Cents;
  amountCalled: Cents;
  alreadyReceived: Cents;
  amountDue: Cents;
  remainingAfter: Cents;
}

/**
 * The table of the email. `uncalledBefore` is the uncalled Balance before
 * this line is sent; "Remaining Balance after this call" is what stays
 * uncalled once it is.
 */
export function noticeAmounts(i: {
  committed: Cents;
  paidToDate: Cents;
  uncalledBefore: Cents;
  amountCalled: Cents;
  alreadyReceived: Cents;
}): NoticeAmounts {
  return {
    committed: i.committed,
    paidToDate: i.paidToDate,
    amountCalled: i.amountCalled,
    alreadyReceived: i.alreadyReceived,
    amountDue: maxBig(0n, i.amountCalled - i.alreadyReceived),
    remainingAfter: maxBig(0n, i.uncalledBefore - i.amountCalled),
  };
}

/** The same amounts as preformatted strings ("$20,000.00"). */
export function formatNoticeAmounts(
  a: NoticeAmounts,
): Record<keyof NoticeAmounts, string> {
  return {
    committed: formatCents(a.committed),
    paidToDate: formatCents(a.paidToDate),
    amountCalled: formatCents(a.amountCalled),
    alreadyReceived: formatCents(a.alreadyReceived),
    amountDue: formatCents(a.amountDue),
    remainingAfter: formatCents(a.remainingAfter),
  };
}

/** `•••• 1234`: the only form of an account number that leaves the server. */
export function maskedAccountNumber(accountNumber: string): string {
  return `•••• ${accountNumber.slice(-4)}`;
}

export const MAIL_CATCHER_BLOCKED =
  "Email is not configured for real delivery. A Call Notice is effective only when actually sent (Section 4.9). Set EMAIL_SERVER and EMAIL_FROM first.";

/** Why `send` would refuse: the mail catcher in production (outside production it is allowed for testing). */
export function sendBlockedReason(i: {
  nodeEnv: string | undefined;
  mailCatcher: boolean;
}): string | null {
  return i.nodeEnv === "production" && i.mailCatcher
    ? MAIL_CATCHER_BLOCKED
    : null;
}
