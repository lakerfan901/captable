import "server-only";

import type {
  ExpenseCategoryEnum,
  ExpenseEntry,
  FundingSourceEnum,
  LlcTerm,
} from "@prisma/client";
import { formatDateOnly, fromDateOnly, toDateOnly } from "@/lib/date-only";
import { todayInZone } from "@/lib/governance/dates";
import {
  type AvailableCashResult,
  type CashLedger,
  computeAvailableCash,
  computeUnusedCapital,
  orgExpenseCapStatus,
  reserveBalances,
} from "@/lib/llc/available-cash";
import { compareIso, type IsoDate, quarterOf } from "@/lib/llc/dates";
import { managementFeeSummary } from "@/lib/llc/management-fee";
import type { Cents } from "@/lib/llc/money";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  advancesOutstanding,
  type CashLedgerRows,
  loanState,
  orgCapCounted,
  type ReserveRow,
  toCashLedger,
} from "./financials.logic";
import { loadLedger } from "./ledger";
import { notFound, ruleViolation } from "./scope";
import {
  assertBooksOpen,
  getEconomicsContext,
  getOrCreateLlcTerm,
} from "./term";

type Tx = TPrismaOrTransaction;

const d = toDateOnly;

/** Every reserve row of the company in effectiveOn, createdAt order (reversals included). */
export async function loadReserveRows(
  tx: Tx,
  companyId: string,
): Promise<(ReserveRow & { id: string; reversesEntryId: string | null })[]> {
  const rows = await tx.reserveEntry.findMany({
    where: { companyId },
    orderBy: [{ effectiveOn: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    effectiveOn: d(r.effectiveOn),
    kind: r.kind,
    type: r.type,
    amountCents: r.amountCents,
    fundingSource: r.fundingSource,
    releaseTo: r.releaseTo,
    reversesEntryId: r.reversesEntryId,
  }));
}

async function loadCashLedgerRows(
  tx: Tx,
  companyId: string,
): Promise<CashLedgerRows> {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  const { config } = await getEconomicsContext(tx, company);
  const ledger = await loadLedger(tx, companyId, config);

  const [revenue, expenses, reserves, defaultPayments, loanPayments, loans] =
    await Promise.all([
      tx.revenuePeriod.findMany({
        where: { companyId },
        orderBy: { month: "asc" },
      }),
      tx.expenseEntry.findMany({
        where: { companyId },
        orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }],
      }),
      loadReserveRows(tx, companyId),
      tx.memberDefaultPayment.findMany({
        where: { companyId },
        select: { paidOn: true, toInterestCents: true, toCostsCents: true },
      }),
      tx.memberLoanPayment.findMany({
        where: { companyId },
        select: {
          paidOn: true,
          principalCents: true,
          interestCents: true,
          fundingSource: true,
        },
      }),
      tx.memberLoan.findMany({
        where: { companyId },
        select: { madeOn: true, principalCents: true },
      }),
    ]);
  const distributions = await tx.distribution.findMany({
    where: { companyId, status: "FINALIZED", isReversal: false },
    select: {
      type: true,
      periodEnd: true,
      paymentDate: true,
      amountCents: true,
    },
  });

  return {
    revenue: revenue.map((r) => ({
      month: d(r.month),
      customerReceiptsCents: r.customerReceiptsCents,
      passThroughFeesCents: r.passThroughFeesCents,
      otherIncomeCents: r.otherIncomeCents,
      assetSaleProceedsCents: r.assetSaleProceedsCents,
      insuranceProceedsCents: r.insuranceProceedsCents,
      managementFeeCents: r.managementFeeCents,
    })),
    expenses: expenses.map((e) => ({
      incurredOn: d(e.incurredOn),
      amountCents: e.amountCents,
      fundingSource: e.fundingSource,
      category: e.category,
      countsTowardOrgCap: e.countsTowardOrgCap,
    })),
    reserves,
    defaultPayments: defaultPayments.map((p) => ({
      paidOn: d(p.paidOn),
      toInterestCents: p.toInterestCents,
      toCostsCents: p.toCostsCents,
    })),
    loanPayments: loanPayments.map((p) => ({
      paidOn: d(p.paidOn),
      principalCents: p.principalCents,
      interestCents: p.interestCents,
      fundingSource: p.fundingSource,
    })),
    loans: loans.map((l) => ({
      madeOn: d(l.madeOn),
      principalCents: l.principalCents,
    })),
    distributions: distributions.map((x) => ({
      type: x.type,
      periodEnd: d(x.periodEnd),
      paymentDate: d(x.paymentDate),
      amountCents: x.amountCents,
    })),
    cashCapital: ledger.cashCapital,
  };
}

/** The company's cash ledger in the library's shape (R20, R21). */
export async function loadCashLedger(
  tx: Tx,
  companyId: string,
): Promise<CashLedger> {
  return toCashLedger(await loadCashLedgerRows(tx, companyId));
}

export async function getUnusedCapital(
  tx: Tx,
  companyId: string,
  asOf: IsoDate,
): Promise<Cents> {
  return computeUnusedCapital(await loadCashLedger(tx, companyId), asOf)
    .unusedCapital;
}

export interface OrgCapEntry {
  source: "expense" | "managerPayment";
  id: string;
  on: IsoDate;
  payee: string;
  category: string;
  amount: Cents;
  resolutionId: string | null;
}

/**
 * R23 counter and limit. `approvedIncrease` is 0: no table stores approved
 * increases; a row above the cap is accepted only with a `resolutionId`.
 */
export async function getOrgCapStatus(
  tx: Tx,
  companyId: string,
  adding?: Cents,
): Promise<
  ReturnType<typeof orgExpenseCapStatus> & { entries: OrgCapEntry[] }
> {
  const term = await getOrCreateLlcTerm(tx, companyId);
  const expenses = await tx.expenseEntry.findMany({
    where: { companyId, countsTowardOrgCap: true },
    orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }],
  });
  const payments = await tx.managerPayment.findMany({
    where: { companyId, countsTowardOrgCap: true },
    orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
  });
  const entries: OrgCapEntry[] = [
    ...expenses.map((e) => ({
      source: "expense" as const,
      id: e.id,
      on: d(e.incurredOn),
      payee: e.payee,
      category: e.category as string,
      amount: e.amountCents,
      resolutionId: e.resolutionId,
    })),
    ...payments.map((p) => ({
      source: "managerPayment" as const,
      id: p.id,
      on: d(p.paidOn),
      payee: p.payee,
      category: p.category as string,
      amount: p.amountCents,
      resolutionId: p.resolutionId,
    })),
  ].sort((a, b) => compareIso(a.on, b.on));
  const counted = orgCapCounted(
    expenses.map((e) => ({
      countsTowardOrgCap: true,
      amountCents: e.amountCents,
    })),
    payments.map((p) => ({
      countsTowardOrgCap: true,
      amountCents: p.amountCents,
    })),
  );
  return {
    ...orgExpenseCapStatus({
      counted,
      cap: term.orgExpenseCapCents,
      approvedIncrease: 0n,
      adding,
    }),
    entries,
  };
}

/**
 * Σ MemberAdvance − Σ MemberAdvanceRecovery per stakeholder (net of
 * reversals). With `asOf`: advances paid and recoveries made on or before it.
 */
export async function getTaxAdvancesOutstanding(
  tx: Tx,
  companyId: string,
  asOf?: IsoDate,
): Promise<Map<string, Cents>> {
  const on = asOf === undefined ? null : fromDateOnly(asOf);
  const advances = await tx.memberAdvance.findMany({
    where: { companyId, ...(on ? { paidOn: { lte: on } } : {}) },
    select: { stakeholderId: true, amountCents: true },
  });
  const recoveries = await tx.memberAdvanceRecovery.findMany({
    where: { companyId, ...(on ? { recoveredOn: { lte: on } } : {}) },
    select: { stakeholderId: true, amountCents: true },
  });
  return advancesOutstanding(advances, recoveries);
}

export interface LoanStateRow {
  loanId: string;
  lenderStakeholderId: string;
  principalOutstanding: Cents;
  accruedInterest: Cents;
  interestPaid: Cents;
  maturityOn: IsoDate;
  pastMaturity: boolean;
}

export async function getLoanStates(
  tx: Tx,
  companyId: string,
  asOf: IsoDate,
): Promise<LoanStateRow[]> {
  const loans = await tx.memberLoan.findMany({
    where: { companyId },
    orderBy: [{ madeOn: "asc" }, { createdAt: "asc" }],
    include: {
      payments: {
        select: { paidOn: true, principalCents: true, interestCents: true },
      },
    },
  });
  return loans.map((l) => {
    const s = loanState(
      {
        madeOn: d(l.madeOn),
        maturityOn: d(l.maturityOn),
        principalCents: l.principalCents,
        interestBps: l.interestBps,
      },
      l.payments.map((p) => ({
        paidOn: d(p.paidOn),
        principalCents: p.principalCents,
        interestCents: p.interestCents,
      })),
      asOf,
    );
    return {
      loanId: l.id,
      lenderStakeholderId: l.lenderStakeholderId,
      maturityOn: d(l.maturityOn),
      ...s,
    };
  });
}

export interface FinancialSummary {
  asOf: IsoDate;
  availableCash: AvailableCashResult;
  unusedCapital: ReturnType<typeof computeUnusedCapital>;
  reserves: ReturnType<typeof reserveBalances>;
  fee: {
    quarter: ReturnType<typeof managementFeeSummary> & {
      from: IsoDate;
      to: IsoDate;
    };
    toDate: ReturnType<typeof managementFeeSummary>;
  };
  orgCap: Awaited<ReturnType<typeof getOrgCapStatus>>;
  loans: LoanStateRow[];
  advancesOutstanding: Cents;
  booksClosedThrough: IsoDate | null;
}

export async function getFinancialSummary(
  tx: Tx,
  companyId: string,
  asOf: IsoDate,
): Promise<FinancialSummary> {
  const ledger = await loadCashLedger(tx, companyId);
  const term = await getOrCreateLlcTerm(tx, companyId);
  const feePayments = (
    await tx.managerPayment.findMany({
      where: { companyId, category: "MANAGEMENT_FEE" },
      select: { paidOn: true, amountCents: true },
    })
  ).map((p) => ({ paidOn: d(p.paidOn), amount: p.amountCents }));
  const q = quarterOf(asOf);
  const quarterRange = {
    from: q.start,
    to: compareIso(q.end, asOf) < 0 ? q.end : asOf,
  };
  let reserves: ReturnType<typeof reserveBalances>;
  try {
    reserves = reserveBalances(ledger.reserves, asOf);
  } catch (e) {
    ruleViolation(
      `The reserve ledger is inconsistent: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const advances = await getTaxAdvancesOutstanding(tx, companyId);
  let advancesTotal = 0n;
  for (const v of advances.values()) advancesTotal += v;
  return {
    asOf,
    availableCash: computeAvailableCash(ledger, asOf),
    unusedCapital: computeUnusedCapital(ledger, asOf),
    reserves,
    fee: {
      quarter: {
        ...quarterRange,
        ...managementFeeSummary(ledger.months, feePayments, quarterRange),
      },
      toDate: managementFeeSummary(ledger.months, feePayments, {
        from: "0001-01-01",
        to: asOf,
      }),
    },
    orgCap: await getOrgCapStatus(tx, companyId),
    loans: await getLoanStates(tx, companyId, asOf),
    advancesOutstanding: advancesTotal,
    booksClosedThrough:
      term.booksClosedThrough === null ? null : d(term.booksClosedThrough),
  };
}

// ---------------------------------------------------------------------------
// Shared procedure helpers (E13)

type FinancialsAuditTarget =
  | "revenuePeriod"
  | "expense"
  | "managerPayment"
  | "reserve"
  | "memberLoan"
  | "memberAdvance";

export type FinancialsCtx = {
  session: { user: { id: string } };
  requestIp: string;
  userAgent: string;
};

export function financialsAudit(
  tx: Tx,
  ctx: FinancialsCtx,
  companyId: string,
  action: AuditSchemaType["action"],
  target: { type: FinancialsAuditTarget; id: string },
  summary: string,
) {
  return Audit.create(
    {
      action,
      companyId,
      actor: { type: "user", id: ctx.session.user.id },
      context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
      target: [target],
      summary,
    },
    tx,
  );
}

const ORG_CAP_MESSAGE =
  "Exceeds the $40,000 cap in Section 6.21; a Preferred Supermajority approval is required.";

/**
 * A `resolutionId` given as the approval of a financial record must name a
 * resolution of THIS company (looked up scoped by `companyId`; another
 * company's id is "not found") that is EFFECTIVE and became effective on or
 * before the record's date `on` (company time zone). Any type is accepted as
 * a plain reference (e.g. a Manager-approved purchase order behind a
 * pass-through payment). With `requireSupermajority` it must also carry a
 * UNIT_VOTE requirement with basis PREFERRED_SUPERMAJORITY (Sections 4.6,
 * 6.21). Throws BAD_REQUEST naming what is missing.
 */
export async function assertResolutionAuthorizes(
  tx: Tx,
  companyId: string,
  resolutionId: string,
  opts: {
    on: IsoDate;
    what: string;
    section?: string;
    requireSupermajority: boolean;
  },
): Promise<void> {
  const r = await tx.resolution.findFirst({
    where: { id: resolutionId, companyId },
    select: {
      status: true,
      effectiveAt: true,
      referenceCode: true,
      title: true,
      requirements: { select: { kind: true, basis: true } },
    },
  });
  if (!r) {
    ruleViolation(
      `The resolution given as the approval of ${opts.what} was not found in this company.`,
    );
  }
  const label = r.referenceCode ?? `"${r.title}"`;
  const cite = opts.section ? ` (Section ${opts.section})` : "";
  if (r.status !== "EFFECTIVE" || r.effectiveAt === null) {
    ruleViolation(
      `Resolution ${label} is not effective (${r.status.toLowerCase()}); only an effective resolution can approve ${opts.what}${cite}.`,
    );
  }
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { timezone: true },
  });
  if (!company) notFound("Company");
  // The calendar date of the instant (not `economicsToday`, which is "now").
  const effectiveOn = todayInZone(r.effectiveAt, company.timezone);
  if (compareIso(effectiveOn, opts.on) > 0) {
    ruleViolation(
      `Resolution ${label} became effective on ${formatDateOnly(effectiveOn)}, after ${formatDateOnly(opts.on)}; it cannot approve ${opts.what} dated earlier${cite}.`,
    );
  }
  if (
    opts.requireSupermajority &&
    !r.requirements.some(
      (q) => q.kind === "UNIT_VOTE" && q.basis === "PREFERRED_SUPERMAJORITY",
    )
  ) {
    ruleViolation(
      `Resolution ${label} was not approved by a Preferred Supermajority, which${opts.section ? ` Section ${opts.section}` : " the Operating Agreement"} requires for ${opts.what}.`,
    );
  }
}

/**
 * R23: rejects a counted amount above the cap unless it carries an effective
 * Preferred Supermajority resolution of the company, effective on or before
 * `on` (`assertResolutionAuthorizes`). Below the cap a given resolution is
 * still verified as a reference (exists in the company, effective by `on`):
 * a stored id always claims an approval.
 */
export async function assertOrgCapAllows(
  tx: Tx,
  companyId: string,
  adding: Cents,
  resolutionId: string | null,
  on: IsoDate,
): Promise<void> {
  const status = await getOrgCapStatus(tx, companyId, adding);
  if (status.wouldExceed && resolutionId === null) {
    ruleViolation(ORG_CAP_MESSAGE);
  }
  if (resolutionId !== null) {
    await assertResolutionAuthorizes(tx, companyId, resolutionId, {
      on,
      what: status.wouldExceed
        ? "organizational and offering expenses above the $40,000 cap"
        : "this payment",
      section: status.wouldExceed ? "6.21" : undefined,
      requireSupermajority: status.wouldExceed,
    });
  }
}

/** Capital-funded spending may not exceed unused capital on its date or today. */
export async function assertUnusedCapitalCovers(
  tx: Tx,
  companyId: string,
  amount: Cents,
  on: IsoDate,
  today: IsoDate,
): Promise<void> {
  const ledger = await loadCashLedger(tx, companyId);
  const atDate = computeUnusedCapital(ledger, on).unusedCapital;
  const now = computeUnusedCapital(ledger, today).unusedCapital;
  let available = now;
  if (atDate < available) available = atDate;
  if (amount > available) {
    ruleViolation(
      `Only ${formatCents(available > 0n ? available : 0n)} of unused capital is available (Section 1.15). Fund it from operating cash or record less.`,
    );
  }
}

export interface NewExpense {
  incurredOn: IsoDate;
  category: ExpenseCategoryEnum;
  payee: string;
  amountCents: Cents;
  fundingSource?: FundingSourceEnum;
  countsTowardOrgCap?: boolean;
  memo: string | null;
  documentId: string | null;
  resolutionId: string | null;
  managerPaymentId: string | null;
}

/** `expense.create` rules + insert (also used by `managerPayment.create`). Caller holds the ledger lock. */
export async function insertExpense(
  tx: Tx,
  args: {
    companyId: string;
    term: LlcTerm;
    today: IsoDate;
    createdById: string;
    expense: NewExpense;
  },
) {
  const { companyId, term, today, expense: e } = args;
  assertNotFuture(e.incurredOn, today);
  assertBooksOpen(term, e.incurredOn);
  const fundingSource =
    e.fundingSource ??
    (e.category === "ORGANIZATIONAL_OFFERING" ||
    e.category === "EQUIPMENT_ACQUISITION"
      ? "CAPITAL_CONTRIBUTIONS"
      : "OPERATING_CASH");
  const countsTowardOrgCap =
    e.countsTowardOrgCap ?? e.category === "ORGANIZATIONAL_OFFERING";
  if (countsTowardOrgCap && e.category === "EQUIPMENT_ACQUISITION") {
    ruleViolation(
      "The price of the servers (Equipment acquisition) does not count toward the Section 6.21 cap.",
    );
  }
  if (countsTowardOrgCap) {
    await assertOrgCapAllows(
      tx,
      companyId,
      e.amountCents,
      e.resolutionId,
      e.incurredOn,
    );
  } else if (e.resolutionId !== null) {
    await assertResolutionAuthorizes(tx, companyId, e.resolutionId, {
      on: e.incurredOn,
      what: "this expense",
      requireSupermajority: false,
    });
  }
  if (fundingSource === "CAPITAL_CONTRIBUTIONS") {
    await assertUnusedCapitalCovers(
      tx,
      companyId,
      e.amountCents,
      e.incurredOn,
      today,
    );
  }
  return await tx.expenseEntry.create({
    data: {
      companyId,
      incurredOn: fromDateOnly(e.incurredOn),
      category: e.category,
      payee: e.payee,
      amountCents: e.amountCents,
      fundingSource,
      countsTowardOrgCap,
      memo: e.memo,
      documentId: e.documentId,
      managerPaymentId: e.managerPaymentId,
      resolutionId: e.resolutionId,
      createdById: args.createdById,
    },
  });
}

/** The reversal row of an expense: dated `today`, negated, same classification. */
export async function insertExpenseReversal(
  tx: Tx,
  args: {
    companyId: string;
    original: ExpenseEntry;
    today: IsoDate;
    createdById: string;
    reason: string;
    managerPaymentId: string | null;
  },
) {
  const o = args.original;
  const already = await tx.expenseEntry.findFirst({
    where: { companyId: args.companyId, reversesEntryId: o.id },
    select: { id: true },
  });
  if (already || o.reversesEntryId !== null || o.amountCents < 0n) {
    ruleViolation("This expense has already been reversed.");
  }
  return await tx.expenseEntry.create({
    data: {
      companyId: args.companyId,
      incurredOn: fromDateOnly(args.today),
      category: o.category,
      payee: o.payee,
      amountCents: -o.amountCents,
      fundingSource: o.fundingSource,
      countsTowardOrgCap: o.countsTowardOrgCap,
      memo: `Reversal: ${args.reason}`,
      documentId: o.documentId,
      managerPaymentId: args.managerPaymentId,
      resolutionId: o.resolutionId,
      reversesEntryId: o.id,
      createdById: args.createdById,
    },
  });
}

/** Rejects a date after `today` (company time zone). */
export function assertNotFuture(date: IsoDate, today: IsoDate): void {
  if (compareIso(date, today) > 0) {
    ruleViolation(
      `${formatDateOnly(date)} is in the future. Record it on or after the day it happens.`,
    );
  }
}
