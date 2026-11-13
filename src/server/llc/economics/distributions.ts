import "server-only";

import { createHash } from "node:crypto";
import type { Distribution, DistributionLine, Prisma } from "@prisma/client";
import { z } from "zod";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { reserveBalances } from "@/lib/llc/available-cash";
import { type LlcEconomicsConfig, OA_DEFAULTS } from "@/lib/llc/config";
import { type IsoDate, quarterOf } from "@/lib/llc/dates";
import { LlcMathError, microUnitsFromDecimal } from "@/lib/llc/money";
import type { PositionsResult } from "@/lib/llc/positions";
import { distributionDeadline } from "@/lib/llc/term";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import {
  type LedgerActor,
  recordCapitalReceipt,
  voidCapitalReceipt,
} from "@/server/llc/commitments";
import { unitsToWire } from "@/server/llc/serialize";
import { ZDistributionInputsSchema } from "@/trpc/routers/distribution/schema";
import { getLineStates, settleNotices } from "./call-notices";
import { economicsToday } from "./clock";
import {
  getDefaultsOwed,
  getOverdueUndeclared,
  getPendingDefaultSteps,
} from "./defaults";
import { livePayments } from "./defaults.logic";
import {
  assertComputationInvariants,
  assertLineRows,
  buildComputation,
  canonicalForHash,
  type DefaultRecordInfo,
  type DistributionComputation,
  type DistributionInputs,
  type DistributionLineRow,
  type DistributionTotalsRow,
  type DistributionType,
  distributionLineRows,
  distributionTotalsRow,
  nextDistributionDeadline,
  offsetWrites,
  reversalLineRows,
  reversalTotalsRow,
  taxRecoveryWrites,
  windDownTopUp,
} from "./distributions.logic";
import {
  getLoanStates,
  getTaxAdvancesOutstanding,
  loadCashLedger,
  loadReserveRows,
} from "./financials";
import { firstOfMonth, reserveLedgerError } from "./financials.logic";
import { getPositions } from "./ledger";
import { conflict, lockCompanyLedger, notFound, ruleViolation } from "./scope";
import {
  closeBooksThrough,
  getEconomicsContext,
  getOrCreateLlcTerm,
} from "./term";
import { toWire } from "./wire";

/*
 * Distributions (R7, R9–R21, R25, R40; OA §5.6, §4.9(iii), §9.2, §11.4).
 * A draft is computed on read and never stored as figures; `finalize`
 * recomputes inside one locked transaction, refuses on any blocker or on a
 * hash that differs from what the Manager reviewed, and writes the permanent
 * record (lines, offsets through FOUNDATION's services, recoveries,
 * liquidation rows). `reverse` writes a negating distribution and reversal
 * rows and voids the offset receipts. Exactly-once: every mutation takes the
 * company ledger lock first, re-reads the row after it and changes status
 * only with `update({ where: { id, companyId, status } })` (P2025 → CONFLICT).
 */

type Tx = PrismaTransactionalClient;
type Reader = TPrismaOrTransaction;
type Company = { id: string; timezone: string };
type MutationInput = { company: Company; actor: LedgerActor };

export type { DistributionComputation, DistributionInputs };

// ---------------------------------------------------------------------------
// Helpers

function createdBy(actor: LedgerActor): string {
  return actor.memberId ?? actor.userId;
}

/** Runs pure library code; an LlcMathError becomes a BAD_REQUEST naming its code. */
function math<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LlcMathError) {
      ruleViolation(`${error.message} (${error.code}).`);
    }
    throw error;
  }
}

function prismaCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** A write guarded by its `where` (or by a unique index): a guard that no longer holds is CONFLICT. */
async function guarded<T>(run: () => Promise<T>, message: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = prismaCode(error);
    if (code === "P2025" || code === "P2002") conflict(message);
    throw error;
  }
}

/** A FOUNDATION service or the ledger returned something other than what was computed: roll back. */
function ledgerDisagrees(what: string): never {
  throw new Error(
    `Ledger write did not match the computed distribution (${what}); nothing was saved.`,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function dateOrNull(d: Date | null): IsoDate | null {
  return d === null ? null : toDateOnly(d);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
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

async function nextNumber(tx: Reader, companyId: string): Promise<number> {
  const max = await tx.distribution.aggregate({
    where: { companyId },
    _max: { number: true },
  });
  return (max._max.number ?? 0) + 1;
}

const TYPE_LABEL: Record<DistributionType, string> = {
  OPERATING: "operating distribution",
  RETURN_OF_UNUSED_CAPITAL: "return of unused capital",
  SALE_OR_LIQUIDATION: "sale or liquidation distribution",
};

function parseInputs(
  row: Pick<Distribution, "type" | "inputs">,
): DistributionInputs {
  const parsed = ZDistributionInputsSchema.safeParse(row.inputs);
  if (!parsed.success || parsed.data.type !== row.type) {
    ruleViolation(
      "The saved inputs of this draft are incomplete or do not match its type; save the draft again.",
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Computation

async function loadDefaultRecords(
  tx: Reader,
  companyId: string,
): Promise<Map<string, DefaultRecordInfo>> {
  const rows = await tx.memberDefault.findMany({
    where: { companyId, status: { not: "VOIDED" } },
    select: {
      id: true,
      stakeholderId: true,
      commitmentId: true,
      callNoticeLineId: true,
      dueOn: true,
      forfeitedOn: true,
      forfeitureConfirmedAt: true,
      creditDate: true,
      creditConfirmedAt: true,
      payments: {
        where: { companyId },
        select: { id: true, paidOn: true, reversesPaymentId: true },
      },
    },
  });
  const out = new Map<string, DefaultRecordInfo>();
  for (const r of rows) {
    let latest: IsoDate | null = null;
    for (const p of livePayments(r.payments)) {
      const on = toDateOnly(p.paidOn);
      if (latest === null || on > latest) latest = on;
    }
    out.set(r.id, {
      memberDefaultId: r.id,
      stakeholderId: r.stakeholderId,
      commitmentId: r.commitmentId,
      callNoticeLineId: r.callNoticeLineId,
      dueOn: toDateOnly(r.dueOn),
      latestLivePaymentOn: latest,
      forfeitedOn:
        r.forfeitureConfirmedAt === null ? null : dateOrNull(r.forfeitedOn),
      creditDate:
        r.creditConfirmedAt === null ? null : dateOrNull(r.creditDate),
    });
  }
  return out;
}

interface ComputedDraft {
  computation: DistributionComputation;
  config: LlcEconomicsConfig;
  positionsBefore: PositionsResult;
  today: IsoDate;
}

/** Everything the run needs, loaded inside `tx`, then the pure computation and its hash. */
async function computeFor(
  tx: Reader,
  company: Company,
  row: Pick<Distribution, "type" | "inputs" | "periodEnd" | "paymentDate">,
): Promise<ComputedDraft> {
  const companyId = company.id;
  const inputs = parseInputs(row);
  const periodEnd = toDateOnly(row.periodEnd);
  const paymentDate = toDateOnly(row.paymentDate);
  // A Preferred class without a price per unit fails here with
  // "Set the price per unit on the Preferred unit class." (E7 buildConfig).
  const { term, config, today } = await getEconomicsContext(tx, company);
  const { ledger, positions } = await getPositions(tx, companyId, paymentDate);
  const positionsAtCutoff =
    config.prefAccrualCutoff === "PERIOD_END"
      ? (await getPositions(tx, companyId, periodEnd)).positions
      : positions;
  const cashLedger = await loadCashLedger(tx, companyId);
  const defaultsOwed = await getDefaultsOwed(tx, companyId, paymentDate);
  const defaultRecords = await loadDefaultRecords(tx, companyId);
  const taxAdvances = await getTaxAdvancesOutstanding(tx, companyId);
  const loanStates = await getLoanStates(tx, companyId, paymentDate);
  const pending = await getPendingDefaultSteps(tx, companyId, paymentDate);
  const overdue = await getOverdueUndeclared(tx, companyId, today);
  const ocd = dateOrNull(term.operationsCommencementDate);
  const savedMonths = cashLedger.months.map((m) => m.month).sort();
  const computation = math(() =>
    buildComputation({
      inputs,
      periodEnd,
      paymentDate,
      today,
      config,
      positionsAtPayment: positions,
      positionsAtCutoff,
      commonUnits: ledger.commonUnits,
      holderMeta: new Map(
        [...ledger.holders.values()].map((h) => [
          h.stakeholderId,
          { name: h.name, isInsider: h.isInsider },
        ]),
      ),
      cashLedger,
      defaultsOwed,
      defaultRecords,
      taxAdvances,
      loanStates,
      pendingDefaultSteps: pending.map((p) => p.message),
      overdueUndeclared: overdue.length,
      lastLedgerEventOn: ledger.lastEventOn,
      booksClosedThrough: dateOrNull(term.booksClosedThrough),
      revenueMonthsSaved: savedMonths,
      requiredFromMonth:
        ocd !== null ? firstOfMonth(ocd) : (savedMonths[0] ?? null),
      deadline:
        inputs.type === "RETURN_OF_UNUSED_CAPITAL"
          ? null
          : distributionDeadline(quarterOf(periodEnd).end, config),
      operationsCommencementDate: ocd,
    }),
  );
  return {
    computation: {
      ...computation,
      hash: sha256(canonicalForHash(computation)),
    },
    config,
    positionsBefore: positions,
    today,
  };
}

/** `distribution.compute`: the figures of a DRAFT as they would be finalized now. */
export async function computeDistribution(
  tx: Reader,
  company: Company,
  id: string,
): Promise<DistributionComputation> {
  const row = await tx.distribution.findFirst({
    where: { id, companyId: company.id },
  });
  if (!row) notFound("Distribution");
  if (row.status !== "DRAFT") {
    ruleViolation(
      "Only a draft is computed; a finalized distribution shows its stored figures.",
    );
  }
  return (await computeFor(tx, company, row)).computation;
}

// ---------------------------------------------------------------------------
// Queries

function distributionView(
  row: Omit<Distribution, "inputs" | "snapshot"> & {
    inputs?: Distribution["inputs"];
  },
) {
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    status: row.status,
    isLiquidation: row.isLiquidation,
    isReversal: row.isReversal,
    reversesDistributionId: row.reversesDistributionId,
    periodStart: dateOrNull(row.periodStart),
    periodEnd: toDateOnly(row.periodEnd),
    paymentDate: toDateOnly(row.paymentDate),
    availableCashCents: row.availableCashCents,
    amountCents: row.amountCents,
    tierCCents: row.tierCCents,
    tierDCents: row.tierDCents,
    tierEPreferredCents: row.tierEPreferredCents,
    tierECommonCents: row.tierECommonCents,
    totalDefaultOffsetCents: row.totalDefaultOffsetCents,
    totalTaxOffsetCents: row.totalTaxOffsetCents,
    totalNetCents: row.totalNetCents,
    reserveBalanceCents: row.reserveBalanceCents,
    solvencyConfirmed: row.solvencyConfirmed,
    finalizedAt: row.finalizedAt,
    finalizedById: row.finalizedById,
    reversedAt: row.reversedAt,
    reversedById: row.reversedById,
    reversalReason: row.reversalReason,
    notes: row.notes,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `distribution.list`: every row (drafts, finalized, reversed, reversals) with totals, newest first, and the next R42 deadline. */
export async function listDistributions(tx: Reader, company: Company) {
  const term = await getOrCreateLlcTerm(tx, company.id);
  const today = economicsToday(company.timezone);
  const rows = await tx.distribution.findMany({
    where: { companyId: company.id },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    omit: { inputs: true, snapshot: true },
  });
  const distributedPeriodEnds = rows
    .filter(
      (r) =>
        r.status === "FINALIZED" &&
        !r.isReversal &&
        r.type !== "RETURN_OF_UNUSED_CAPITAL",
    )
    .map((r) => toDateOnly(r.periodEnd));
  // Only the deadline days are read; the price per unit is not needed here.
  const cfg: LlcEconomicsConfig = {
    ...OA_DEFAULTS,
    distributionDeadlineDays: term.distributionDeadlineDays,
  };
  return {
    today,
    rows: rows.map((r) => distributionView(r)),
    nextDeadline: nextDistributionDeadline(today, cfg, distributedPeriodEnds),
  };
}

function lineView(l: DistributionLine) {
  return {
    id: l.id,
    stakeholderId: l.stakeholderId,
    preferredUnits: microUnitsFromDecimal(unitsToWire(l.preferredUnits)),
    commonUnits: microUnitsFromDecimal(unitsToWire(l.commonUnits)),
    unpaidReturnBeforeCents: l.unpaidReturnBeforeCents,
    unreturnedBeforeCents: l.unreturnedBeforeCents,
    tierCCents: l.tierCCents,
    tierDCents: l.tierDCents,
    tierEPreferredCents: l.tierEPreferredCents,
    tierECommonCents: l.tierECommonCents,
    grossCents: l.grossCents,
    defaultOffsetBalanceCents: l.defaultOffsetBalanceCents,
    defaultOffsetInterestCents: l.defaultOffsetInterestCents,
    defaultOffsetCostsCents: l.defaultOffsetCostsCents,
    taxAdvanceOffsetCents: l.taxAdvanceOffsetCents,
    netCents: l.netCents,
    unpaidReturnAfterCents: l.unpaidReturnBeforeCents - l.tierCCents,
    unreturnedAfterCents: l.unreturnedBeforeCents - l.tierDCents,
    paidOn: dateOrNull(l.paidOn),
    paymentReference: l.paymentReference,
    noticeEmailLogId: l.noticeEmailLogId,
    noticeSentAt: l.noticeSentAt,
  };
}

/** `distribution.get`: the row, its lines with member names, the stored snapshot (null for a draft) and the reversal links. */
export async function getDistribution(
  tx: Reader,
  companyId: string,
  id: string,
) {
  const row = await tx.distribution.findFirst({
    where: { id, companyId },
    include: { lines: { orderBy: [{ stakeholderId: "asc" }] } },
  });
  if (!row) notFound("Distribution");
  const stakeholders = await tx.stakeholder.findMany({
    where: { companyId, id: { in: row.lines.map((l) => l.stakeholderId) } },
    select: { id: true, name: true, isInsider: true },
  });
  const byId = new Map(stakeholders.map((s) => [s.id, s]));
  const reversedBy = row.isReversal
    ? null
    : await tx.distribution.findFirst({
        where: { companyId, reversesDistributionId: row.id },
        select: { id: true, number: true },
      });
  const reverses =
    row.reversesDistributionId === null
      ? null
      : await tx.distribution.findFirst({
          where: { companyId, id: row.reversesDistributionId },
          select: { id: true, number: true },
        });
  return {
    distribution: { ...distributionView(row), inputs: row.inputs },
    lines: row.lines.map((l) => ({
      ...lineView(l),
      name: byId.get(l.stakeholderId)?.name ?? "",
      isInsider: byId.get(l.stakeholderId)?.isInsider ?? false,
    })),
    snapshot: row.snapshot,
    reversedBy,
    reverses,
  };
}

// ---------------------------------------------------------------------------
// Drafts

export async function saveDistributionDraft(
  tx: Tx,
  i: MutationInput & {
    id?: string;
    type: DistributionType;
    periodStart: IsoDate | null;
    periodEnd: IsoDate;
    paymentDate: IsoDate;
    inputs: DistributionInputs;
    notes: string | null;
  },
): Promise<{ id: string }> {
  const companyId = i.company.id;
  if (i.inputs.type !== i.type) {
    ruleViolation("The inputs do not match the distribution type.");
  }
  if (i.periodStart !== null && i.periodStart > i.periodEnd) {
    ruleViolation("The period start must not be after the period end.");
  }
  await lockCompanyLedger(tx, companyId);
  const data = {
    type: i.type,
    isLiquidation:
      i.inputs.type === "SALE_OR_LIQUIDATION" && i.inputs.liquidation !== null,
    periodStart: i.periodStart === null ? null : fromDateOnly(i.periodStart),
    periodEnd: fromDateOnly(i.periodEnd),
    paymentDate: fromDateOnly(i.paymentDate),
    inputs: asJson(i.inputs),
    notes: i.notes,
  };
  let id: string;
  if (i.id !== undefined) {
    const existing = await tx.distribution.findFirst({
      where: { id: i.id, companyId },
      select: { id: true, status: true },
    });
    if (!existing) notFound("Distribution");
    if (existing.status !== "DRAFT") {
      conflict("This distribution is no longer a draft.");
    }
    await guarded(
      () =>
        tx.distribution.update({
          where: { id: existing.id, companyId, status: "DRAFT" },
          data,
        }),
      "This distribution is no longer a draft.",
    );
    id = existing.id;
  } else {
    const created = await tx.distribution.create({
      data: {
        companyId,
        status: "DRAFT",
        createdById: createdBy(i.actor),
        ...data,
      },
      select: { id: true },
    });
    id = created.id;
  }
  await audit(
    tx,
    i.actor,
    companyId,
    "distribution.draft-saved",
    [{ type: "distribution", id }],
    `${i.actor.name} saved a draft ${TYPE_LABEL[i.type]} for the period ending ${i.periodEnd}, payment date ${i.paymentDate}.`,
  );
  return { id };
}

/** The only hard delete in economics (a DRAFT has no lines and no ledger effect). */
export async function deleteDistributionDraft(
  tx: Tx,
  i: MutationInput & { id: string },
): Promise<{ id: string }> {
  const companyId = i.company.id;
  await lockCompanyLedger(tx, companyId);
  const row = await tx.distribution.findFirst({
    where: { id: i.id, companyId },
    select: { id: true, status: true, type: true, periodEnd: true },
  });
  if (!row) notFound("Distribution");
  if (row.status !== "DRAFT") {
    ruleViolation(
      "Only a draft can be deleted; reverse a finalized distribution instead.",
    );
  }
  const lines = await tx.distributionLine.count({
    where: { companyId, distributionId: row.id },
  });
  if (lines > 0) {
    throw new Error(`Draft distribution ${row.id} has lines; nothing deleted.`);
  }
  await guarded(
    () =>
      tx.distribution.delete({
        where: { id: row.id, companyId, status: "DRAFT" },
      }),
    "This distribution is no longer a draft.",
  );
  await audit(
    tx,
    i.actor,
    companyId,
    "distribution.draft-deleted",
    [{ type: "distribution", id: row.id }],
    `${i.actor.name} deleted the draft ${TYPE_LABEL[row.type]} for the period ending ${toDateOnly(row.periodEnd)}.`,
  );
  return { id: row.id };
}

// ---------------------------------------------------------------------------
// Finalize

interface WrittenIds {
  capitalReceiptIds: string[];
  allocationIds: string[];
  memberDefaultPaymentIds: string[];
  advanceRecoveryIds: string[];
  loanPaymentIds: string[];
  managerPaymentIds: string[];
  reserveEntryIds: string[];
}

const ZWrittenIds = z.object({
  capitalReceiptIds: z.array(z.string()),
  allocationIds: z.array(z.string()),
  memberDefaultPaymentIds: z.array(z.string()),
  advanceRecoveryIds: z.array(z.string()),
  loanPaymentIds: z.array(z.string()),
  managerPaymentIds: z.array(z.string()),
  reserveEntryIds: z.array(z.string()),
});

/**
 * In-transaction proof that the permanent record is consistent before it is
 * committed: the full ledger (with this distribution and its offset
 * receipts) replays without error and agrees with FOUNDATION's holdings, and
 * the positions up to and including the distribution event reproduce every
 * line's after-figures.
 */
async function verifyLedgerAfterFinalize(
  tx: Reader,
  companyId: string,
  distributionId: string,
  c: DistributionComputation,
): Promise<void> {
  const { ledger } = await getPositions(tx, companyId, c.paymentDate);
  const event = ledger.events.find(
    (e) => e.kind === "DISTRIBUTION" && e.distributionId === distributionId,
  );
  if (!event) ledgerDisagrees("distribution missing from the ledger");
  const { positions } = await getPositions(tx, companyId, c.paymentDate, {
    untilSeq: event.seq + 1,
  });
  for (const l of c.lines) {
    const h = positions.holders.get(l.stakeholderId);
    if (
      (h?.unpaidReturn ?? 0n) !== l.unpaidReturnAfter ||
      (h?.unreturned ?? 0n) !== l.unreturnedAfter ||
      (h?.preferredUnits ?? 0n) !== l.preferredUnits
    ) {
      ledgerDisagrees(`positions after the distribution for ${l.name}`);
    }
  }
}

export async function finalizeDistribution(
  tx: Tx,
  i: MutationInput & {
    id: string;
    expectedHash: string;
    solvencyConfirmed: boolean;
  },
) {
  const companyId = i.company.id;
  const by = createdBy(i.actor);
  // 1. Lock, re-read, recompute.
  await lockCompanyLedger(tx, companyId);
  const row = await tx.distribution.findFirst({
    where: { id: i.id, companyId },
  });
  if (!row) notFound("Distribution");
  if (row.status !== "DRAFT") {
    conflict(
      `This distribution is no longer a draft${row.number === null ? "" : ` (No. ${row.number})`}.`,
    );
  }
  if (i.solvencyConfirmed !== true) {
    ruleViolation(
      "Confirm that the LLC will be able to pay its debts as they come due and that its assets will exceed its liabilities after this distribution (W.S. 17-29-405, Section 5.6(a)).",
    );
  }
  const {
    computation: c,
    config,
    positionsBefore,
    today,
  } = await computeFor(tx, i.company, row);
  if (c.blockers.length > 0) {
    ruleViolation(
      `This distribution cannot be finalized: ${c.blockers.map((b) => b.message).join(" ")}`,
    );
  }
  if (c.hash !== i.expectedHash) {
    conflict("Figures changed since review; review the distribution again.");
  }
  math(() => assertComputationInvariants(c));
  const totals = distributionTotalsRow(c);
  const lineRows = distributionLineRows(c);
  math(() => assertLineRows(lineRows, totals));
  const paymentDate = c.paymentDate;
  const paymentDb = fromDateOnly(paymentDate);

  // 2. Freeze the Distribution (DRAFT → FINALIZED exactly once).
  const number = await nextNumber(tx, companyId);
  const finalizedAt = new Date();
  await guarded(
    () =>
      tx.distribution.update({
        where: { id: row.id, companyId, status: "DRAFT" },
        data: {
          status: "FINALIZED",
          number,
          isLiquidation: c.isLiquidation,
          ...totals,
          solvencyConfirmed: true,
          finalizedAt,
          finalizedById: by,
        },
      }),
    "This distribution was finalized or changed in the meantime.",
  );

  // 3. One line per holder, zero lines included.
  const created = await tx.distributionLine.createManyAndReturn({
    data: lineRows.map((r) => ({
      companyId,
      distributionId: row.id,
      ...r,
    })),
    select: { id: true, stakeholderId: true },
  });
  if (created.length !== lineRows.length) ledgerDisagrees("line count");
  const lineIdOf = new Map(created.map((l) => [l.stakeholderId, l.id]));
  const lineId = (stakeholderId: string) => {
    const id = lineIdOf.get(stakeholderId);
    if (id === undefined) ledgerDisagrees(`no line for ${stakeholderId}`);
    return id;
  };

  const written: WrittenIds = {
    capitalReceiptIds: [],
    allocationIds: [],
    memberDefaultPaymentIds: [],
    advanceRecoveryIds: [],
    loanPaymentIds: [],
    managerPaymentIds: [],
    reserveEntryIds: [],
  };

  // 4. §4.9(iii) offsets: receipt (Balance part) + allocation + payment row.
  const touchedLines = new Set<string>();
  for (const w of offsetWrites(c)) {
    let capitalReceiptId: string | null = null;
    if (w.receipt !== null) {
      const planned = w.receipt;
      const receipt = await recordCapitalReceipt(
        tx,
        {
          companyId,
          commitmentId: planned.commitmentId,
          receivedOn: paymentDate,
          amountCents: planned.amount,
          dueDate: planned.dueOn,
          note: `Distribution No. ${number} withheld under Section 4.9(iii)`,
          sourceType: "distribution",
          sourceId: row.id,
        },
        i.actor,
      );
      if (
        receipt.kind !== "BALANCE" ||
        receipt.stakeholderId !== w.stakeholderId ||
        receipt.appliedCents !== planned.amount ||
        dateOrNull(receipt.appliedOn) !== paymentDate ||
        microUnitsFromDecimal(unitsToWire(receipt.unitsIssued)) !==
          planned.units
      ) {
        ledgerDisagrees("§4.9(iii) Balance receipt");
      }
      capitalReceiptId = receipt.id;
      written.capitalReceiptIds.push(receipt.id);
      const allocation = await tx.callNoticeAllocation.create({
        data: {
          companyId,
          callNoticeLineId: planned.callNoticeLineId,
          capitalReceiptId: receipt.id,
          amountCents: planned.amount,
          receivedOn: paymentDb,
          prefReturnStartOn: paymentDb,
          source: "OFFSET",
          createdById: by,
        },
        select: { id: true },
      });
      written.allocationIds.push(allocation.id);
      touchedLines.add(planned.callNoticeLineId);
    }
    const payment = await tx.memberDefaultPayment.create({
      data: {
        companyId,
        memberDefaultId: w.memberDefaultId,
        paidOn: paymentDb,
        source: "DISTRIBUTION_OFFSET",
        toBalanceCents: w.toBalance,
        toInterestCents: w.toInterest,
        toCostsCents: w.toCosts,
        capitalReceiptId,
        distributionLineId: lineId(w.stakeholderId),
        createdById: by,
      },
      select: { id: true },
    });
    written.memberDefaultPaymentIds.push(payment.id);
  }
  // A line with nothing outstanding becomes PAID; its notice may settle.
  const notices = new Set<string>();
  for (const id of touchedLines) {
    const line = await tx.callNoticeLine.findFirst({
      where: { id, companyId },
      select: { callNoticeId: true },
    });
    if (!line) ledgerDisagrees(`Call Notice line ${id}`);
    const state = (
      await getLineStates(tx, companyId, today, {
        callNoticeId: line.callNoticeId,
      })
    ).find((s) => s.lineId === id);
    if (!state) ledgerDisagrees(`state of Call Notice line ${id}`);
    if (state.outstanding < 0n) ledgerDisagrees("line overpaid");
    if (state.outstanding === 0n && state.status === "SENT") {
      await guarded(
        () =>
          tx.callNoticeLine.update({
            where: { id, companyId, status: "SENT" },
            data: { status: "PAID", paidInFullOn: paymentDb },
          }),
        "A Call Notice line changed in the meantime.",
      );
      notices.add(line.callNoticeId);
    }
  }
  await settleNotices(tx, companyId, [...notices]);

  // 5. §9.2 tax advance recoveries.
  for (const r of taxRecoveryWrites(c)) {
    const recovery = await tx.memberAdvanceRecovery.create({
      data: {
        companyId,
        stakeholderId: r.stakeholderId,
        recoveredOn: paymentDb,
        amountCents: r.amount,
        source: "DISTRIBUTION_OFFSET",
        distributionLineId: lineId(r.stakeholderId),
        createdById: by,
      },
      select: { id: true },
    });
    written.advanceRecoveryIds.push(recovery.id);
  }

  // 6. Liquidation (§11.4): member loans, Manager creditor rows, wind-down reserve.
  if (c.liquidation !== null) {
    for (const loan of c.liquidation.loanPayments) {
      const owned = await tx.memberLoan.findFirst({
        where: { id: loan.loanId, companyId },
        select: { id: true },
      });
      if (!owned) ledgerDisagrees(`member loan ${loan.loanId}`);
      const payment = await tx.memberLoanPayment.create({
        data: {
          companyId,
          memberLoanId: loan.loanId,
          paidOn: paymentDb,
          principalCents: loan.principal,
          interestCents: loan.interest,
          fundingSource: "OPERATING_CASH",
          distributionId: row.id,
          createdById: by,
        },
        select: { id: true },
      });
      written.loanPaymentIds.push(payment.id);
    }
    for (const creditor of c.liquidation.creditorRows) {
      if (creditor.managerCategory === null || creditor.amount === 0n) continue;
      const payment = await tx.managerPayment.create({
        data: {
          companyId,
          paidOn: paymentDb,
          payee: creditor.payee,
          amountCents: creditor.amount,
          category: creditor.managerCategory,
          countsTowardOrgCap: false,
          memo:
            creditor.memo.length > 0
              ? `${creditor.memo} (Distribution No. ${number}, Section 11.4(a))`
              : `Distribution No. ${number}, Section 11.4(a)`,
          createdById: by,
        },
        select: { id: true },
      });
      written.managerPaymentIds.push(payment.id);
    }
    if (c.liquidation.windDownReserve > 0n) {
      const reserves = (await loadCashLedger(tx, companyId)).reserves;
      const current = math(
        () =>
          reserveBalances(reserves, paymentDate).byKind.get("WIND_DOWN")
            ?.total ?? 0n,
      );
      const topUp = windDownTopUp(c.liquidation.windDownReserve, current);
      if (topUp > 0n) {
        const entry = await tx.reserveEntry.create({
          data: {
            companyId,
            effectiveOn: paymentDb,
            kind: "WIND_DOWN",
            type: "ESTABLISH",
            amountCents: topUp,
            fundingSource: "OPERATING_CASH",
            reason: `Wind-down reserve retained by Distribution No. ${number} (Section 11.4)`,
            createdById: by,
          },
          select: { id: true },
        });
        written.reserveEntryIds.push(entry.id);
      }
    }
  }

  // 7. Close the books through the period end.
  if (c.type !== "RETURN_OF_UNUSED_CAPITAL") {
    await closeBooksThrough(tx, companyId, c.periodEnd);
  }

  // Evidence: the computation, the config, the positions before and the rows written.
  await guarded(
    () =>
      tx.distribution.update({
        where: { id: row.id, companyId, status: "FINALIZED" },
        data: {
          snapshot: asJson(
            toWire({
              computation: c,
              config,
              positionsBefore: positionsBefore.holders,
              written,
            }),
          ),
        },
      }),
    "This distribution changed in the meantime.",
  );

  await verifyLedgerAfterFinalize(tx, companyId, row.id, c);

  // 8. Audit.
  const paid = c.lines.filter((l) => l.net > 0n).length;
  await audit(
    tx,
    i.actor,
    companyId,
    "distribution.finalized",
    [{ type: "distribution", id: row.id }],
    `Distribution No. ${number} finalized: ${formatCents(c.amount)} gross, ${formatCents(c.totalNet)} net to ${paid} member${paid === 1 ? "" : "s"} (${TYPE_LABEL[c.type]}, payment date ${paymentDate}; default offsets ${formatCents(c.totalDefaultOffset)}, tax advances recovered ${formatCents(c.totalTaxOffset)}; solvency confirmed under W.S. 17-29-405 by ${i.actor.name}).`,
  );

  return {
    id: row.id,
    number,
    amount: c.amount,
    totalNet: c.totalNet,
    lineCount: created.length,
    hash: c.hash,
  };
}

// ---------------------------------------------------------------------------
// Reverse

function lineRowFromDb(l: DistributionLine): DistributionLineRow {
  return {
    stakeholderId: l.stakeholderId,
    preferredUnits: unitsToWire(l.preferredUnits),
    commonUnits: unitsToWire(l.commonUnits),
    unpaidReturnBeforeCents: l.unpaidReturnBeforeCents,
    unreturnedBeforeCents: l.unreturnedBeforeCents,
    tierCCents: l.tierCCents,
    tierDCents: l.tierDCents,
    tierEPreferredCents: l.tierEPreferredCents,
    tierECommonCents: l.tierECommonCents,
    grossCents: l.grossCents,
    defaultOffsetBalanceCents: l.defaultOffsetBalanceCents,
    defaultOffsetInterestCents: l.defaultOffsetInterestCents,
    defaultOffsetCostsCents: l.defaultOffsetCostsCents,
    taxAdvanceOffsetCents: l.taxAdvanceOffsetCents,
    netCents: l.netCents,
  };
}

function totalsFromDb(d: Distribution): DistributionTotalsRow {
  if (
    d.amountCents === null ||
    d.tierCCents === null ||
    d.tierDCents === null ||
    d.tierEPreferredCents === null ||
    d.tierECommonCents === null ||
    d.totalDefaultOffsetCents === null ||
    d.totalTaxOffsetCents === null ||
    d.totalNetCents === null
  ) {
    throw new Error(`Finalized distribution ${d.id} has no frozen totals.`);
  }
  return {
    availableCashCents: d.availableCashCents,
    amountCents: d.amountCents,
    tierCCents: d.tierCCents,
    tierDCents: d.tierDCents,
    tierEPreferredCents: d.tierEPreferredCents,
    tierECommonCents: d.tierECommonCents,
    totalDefaultOffsetCents: d.totalDefaultOffsetCents,
    totalTaxOffsetCents: d.totalTaxOffsetCents,
    totalNetCents: d.totalNetCents,
    reserveBalanceCents: d.reserveBalanceCents,
  };
}

function after(a: Date | null, b: Date): boolean {
  return a !== null && a.getTime() > b.getTime();
}

export async function reverseDistribution(
  tx: Tx,
  i: MutationInput & { id: string; reason: string },
) {
  const companyId = i.company.id;
  const by = createdBy(i.actor);
  const reason = i.reason.trim();
  if (reason.length < 10) {
    ruleViolation("Give a reason for the reversal (at least 10 characters).");
  }

  // Lock, re-read and check everything before writing anything.
  await lockCompanyLedger(tx, companyId);
  const original = await tx.distribution.findFirst({
    where: { id: i.id, companyId },
    include: { lines: true },
  });
  if (!original) notFound("Distribution");
  if (original.isReversal) {
    ruleViolation("A reversal cannot itself be reversed.");
  }
  if (original.status === "REVERSED") {
    conflict("This distribution has already been reversed.");
  }
  if (original.status !== "FINALIZED") {
    ruleViolation(
      "Only a finalized distribution can be reversed; delete a draft instead.",
    );
  }
  const number = original.number;
  const finalizedAt = original.finalizedAt;
  if (number === null || finalizedAt === null) {
    throw new Error(`Finalized distribution ${original.id} has no number.`);
  }
  const latest = await tx.distribution.findFirst({
    where: { companyId, status: "FINALIZED", isReversal: false },
    orderBy: { number: "desc" },
    select: { id: true, number: true },
  });
  if (!latest || latest.id !== original.id) {
    ruleViolation(
      `Only the latest finalized distribution can be reversed; reverse distribution No. ${latest?.number ?? ""} first.`,
    );
  }
  const totals = totalsFromDb(original);
  const lineRows = original.lines.map(lineRowFromDb);
  math(() => assertLineRows(lineRows, totals));
  const lineIds = original.lines.map((l) => l.id);
  const stakeholderOfLine = new Map(
    original.lines.map((l) => [l.id, l.stakeholderId]),
  );

  const snapshot = z
    .object({ written: ZWrittenIds })
    .safeParse(original.snapshot);
  if (!snapshot.success) {
    throw new Error(
      `Distribution ${original.id} has no record of the rows it wrote.`,
    );
  }
  const written = snapshot.data.written;

  // §4.9(iii) payments and their receipts.
  const payments = await tx.memberDefaultPayment.findMany({
    where: { companyId, distributionLineId: { in: lineIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (
    payments.some(
      (p) => p.reversesPaymentId !== null || p.source !== "DISTRIBUTION_OFFSET",
    ) ||
    payments.length !== written.memberDefaultPaymentIds.length ||
    payments.some((p) => !written.memberDefaultPaymentIds.includes(p.id))
  ) {
    throw new Error(
      `The default payments of distribution ${original.id} do not match its record.`,
    );
  }
  const paymentIds = payments.map((p) => p.id);
  const alreadyReversedPayment =
    paymentIds.length === 0
      ? null
      : await tx.memberDefaultPayment.findFirst({
          where: { companyId, reversesPaymentId: { in: paymentIds } },
          select: { id: true },
        });
  if (alreadyReversedPayment) {
    conflict("The default offsets of this distribution were already reversed.");
  }
  const defaults =
    payments.length === 0
      ? []
      : await tx.memberDefault.findMany({
          where: {
            companyId,
            id: { in: [...new Set(payments.map((p) => p.memberDefaultId))] },
          },
          select: {
            id: true,
            stakeholderId: true,
            forfeitureConfirmedAt: true,
            creditConfirmedAt: true,
            curedAt: true,
          },
        });
  for (const d of defaults) {
    if (
      after(d.forfeitureConfirmedAt, finalizedAt) ||
      after(d.creditConfirmedAt, finalizedAt) ||
      after(d.curedAt, finalizedAt)
    ) {
      ruleViolation(
        "A default this distribution applied money to has since had its forfeiture, credit or cure confirmed; the distribution can no longer be reversed (Section 4.9).",
      );
    }
  }
  const receipts = await tx.capitalReceipt.findMany({
    where: { companyId, sourceType: "distribution", sourceId: original.id },
    select: { id: true, appliedCents: true, voidedAt: true },
  });
  const paymentReceiptIds = payments
    .map((p) => p.capitalReceiptId)
    .filter((id): id is string => id !== null)
    .sort();
  const receiptIds = receipts.map((r) => r.id).sort();
  if (
    paymentReceiptIds.join(",") !== receiptIds.join(",") ||
    [...written.capitalReceiptIds].sort().join(",") !== receiptIds.join(",")
  ) {
    throw new Error(
      `The receipts of distribution ${original.id} do not match its default payments.`,
    );
  }
  if (receipts.some((r) => r.voidedAt !== null)) {
    ruleViolation(
      "A receipt this distribution created has since been voided; the distribution can no longer be reversed.",
    );
  }
  const allocations =
    receiptIds.length === 0
      ? []
      : await tx.callNoticeAllocation.findMany({
          where: { companyId, capitalReceiptId: { in: receiptIds } },
          select: {
            id: true,
            capitalReceiptId: true,
            amountCents: true,
            source: true,
            reversesAllocationId: true,
          },
        });
  for (const r of receipts) {
    const rows = allocations.filter((a) => a.capitalReceiptId === r.id);
    const only = rows[0];
    if (
      rows.length !== 1 ||
      !only ||
      only.source !== "OFFSET" ||
      only.reversesAllocationId !== null ||
      only.amountCents !== r.appliedCents ||
      !written.allocationIds.includes(only.id)
    ) {
      ruleViolation(
        "A receipt this distribution created has since been allocated or reversed; the distribution can no longer be reversed.",
      );
    }
  }

  // §9.2 recoveries, §11.4 loan payments, Manager payments, reserve entries.
  const recoveries = await tx.memberAdvanceRecovery.findMany({
    where: { companyId, distributionLineId: { in: lineIds } },
  });
  const loanPayments = await tx.memberLoanPayment.findMany({
    where: { companyId, distributionId: original.id },
  });
  const managerPayments =
    written.managerPaymentIds.length === 0
      ? []
      : await tx.managerPayment.findMany({
          where: { companyId, id: { in: written.managerPaymentIds } },
        });
  const reserveEntries =
    written.reserveEntryIds.length === 0
      ? []
      : await tx.reserveEntry.findMany({
          where: { companyId, id: { in: written.reserveEntryIds } },
        });
  const sameIds = (rows: { id: string }[], ids: string[]) =>
    rows.length === ids.length && rows.every((r) => ids.includes(r.id));
  if (
    !sameIds(recoveries, written.advanceRecoveryIds) ||
    !sameIds(loanPayments, written.loanPaymentIds) ||
    !sameIds(managerPayments, written.managerPaymentIds) ||
    !sameIds(reserveEntries, written.reserveEntryIds)
  ) {
    throw new Error(
      `The rows written by distribution ${original.id} do not match its record.`,
    );
  }
  const reversedAlready = await Promise.all([
    recoveries.length === 0
      ? null
      : tx.memberAdvanceRecovery.findFirst({
          where: {
            companyId,
            reversesRecoveryId: { in: recoveries.map((r) => r.id) },
          },
          select: { id: true },
        }),
    loanPayments.length === 0
      ? null
      : tx.memberLoanPayment.findFirst({
          where: {
            companyId,
            reversesPaymentId: { in: loanPayments.map((p) => p.id) },
          },
          select: { id: true },
        }),
    managerPayments.length === 0
      ? null
      : tx.managerPayment.findFirst({
          where: {
            companyId,
            reversesPaymentId: { in: managerPayments.map((p) => p.id) },
          },
          select: { id: true },
        }),
    reserveEntries.length === 0
      ? null
      : tx.reserveEntry.findFirst({
          where: {
            companyId,
            reversesEntryId: { in: reserveEntries.map((r) => r.id) },
          },
          select: { id: true },
        }),
  ]);
  if (reversedAlready.some((r) => r !== null)) {
    ruleViolation(
      "A loan payment, Manager payment or reserve entry of this distribution was reversed separately; the distribution can no longer be reversed here.",
    );
  }
  if (reserveEntries.length > 0) {
    const ledgerRows = await loadReserveRows(tx, companyId);
    const error = reserveLedgerError([
      ...ledgerRows,
      ...reserveEntries.map((r) => ({
        effectiveOn: toDateOnly(r.effectiveOn),
        kind: r.kind,
        type: r.type,
        amountCents: -r.amountCents,
        fundingSource: r.fundingSource,
        releaseTo: r.releaseTo,
      })),
    ]);
    if (error !== null) {
      ruleViolation(
        `Reversing the wind-down reserve of this distribution would make a reserve negative: ${error}`,
      );
    }
  }

  // Write: status first (REVERSED exactly once), then the reversal distribution.
  const reversedAt = new Date();
  await guarded(
    () =>
      tx.distribution.update({
        where: {
          id: original.id,
          companyId,
          status: "FINALIZED",
          isReversal: false,
        },
        data: {
          status: "REVERSED",
          reversedAt,
          reversedById: by,
          reversalReason: reason,
        },
      }),
    "This distribution has already been reversed.",
  );
  const reversalNumber = await nextNumber(tx, companyId);
  const reversal = await guarded(
    () =>
      tx.distribution.create({
        data: {
          companyId,
          number: reversalNumber,
          type: original.type,
          status: "FINALIZED",
          isLiquidation: original.isLiquidation,
          isReversal: true,
          reversesDistributionId: original.id,
          periodStart: original.periodStart,
          periodEnd: original.periodEnd,
          paymentDate: original.paymentDate,
          inputs: asJson(original.inputs),
          ...reversalTotalsRow(totals),
          snapshot: asJson({
            reverses: { id: original.id, number },
            reason,
          }),
          solvencyConfirmed: false,
          finalizedAt: reversedAt,
          finalizedById: by,
          notes: reason,
          createdById: by,
        },
        select: { id: true },
      }),
    "This distribution has already been reversed.",
  );
  const reversalLines = await tx.distributionLine.createManyAndReturn({
    data: reversalLineRows(lineRows).map((r) => ({
      companyId,
      distributionId: reversal.id,
      ...r,
    })),
    select: { id: true, stakeholderId: true },
  });
  if (reversalLines.length !== lineRows.length) {
    ledgerDisagrees("reversal line count");
  }
  const reversalLineOf = new Map(
    reversalLines.map((l) => [l.stakeholderId, l.id]),
  );
  const reversalLineFor = (originalLineId: string | null) => {
    const stakeholderId =
      originalLineId === null
        ? undefined
        : stakeholderOfLine.get(originalLineId);
    const id =
      stakeholderId === undefined
        ? undefined
        : reversalLineOf.get(stakeholderId);
    if (id === undefined) ledgerDisagrees("reversal line");
    return id;
  };

  // Reversal rows keep the original dates, so every as-of figure (default
  // interest and costs paid, advances outstanding, loans, reserves, Available
  // Cash) returns exactly to its value before the run; E11 ignores a reversed
  // payment and its reversal row in its date checks (`livePayments`).
  for (const p of payments) {
    await tx.memberDefaultPayment.create({
      data: {
        companyId,
        memberDefaultId: p.memberDefaultId,
        paidOn: p.paidOn,
        source: p.source,
        toBalanceCents: -p.toBalanceCents,
        toInterestCents: -p.toInterestCents,
        toCostsCents: -p.toCostsCents,
        capitalReceiptId: p.capitalReceiptId,
        distributionLineId: reversalLineFor(p.distributionLineId),
        reversesPaymentId: p.id,
        createdById: by,
      },
    });
  }
  for (const r of recoveries) {
    await tx.memberAdvanceRecovery.create({
      data: {
        companyId,
        stakeholderId: r.stakeholderId,
        recoveredOn: r.recoveredOn,
        amountCents: -r.amountCents,
        source: r.source,
        distributionLineId: reversalLineFor(r.distributionLineId),
        reversesRecoveryId: r.id,
        createdById: by,
      },
    });
  }
  for (const p of loanPayments) {
    await tx.memberLoanPayment.create({
      data: {
        companyId,
        memberLoanId: p.memberLoanId,
        paidOn: p.paidOn,
        principalCents: -p.principalCents,
        interestCents: -p.interestCents,
        fundingSource: p.fundingSource,
        distributionId: reversal.id,
        reversesPaymentId: p.id,
        createdById: by,
      },
    });
  }
  for (const p of managerPayments) {
    await tx.managerPayment.create({
      data: {
        companyId,
        paidOn: p.paidOn,
        payee: p.payee,
        payeeStakeholderId: p.payeeStakeholderId,
        amountCents: -p.amountCents,
        category: p.category,
        countsTowardOrgCap: p.countsTowardOrgCap,
        memo: `Reversal of distribution No. ${number}: ${reason}`,
        documentId: p.documentId,
        resolutionId: p.resolutionId,
        reversesPaymentId: p.id,
        createdById: by,
      },
    });
  }
  for (const e of reserveEntries) {
    await tx.reserveEntry.create({
      data: {
        companyId,
        effectiveOn: e.effectiveOn,
        kind: e.kind,
        type: e.type,
        amountCents: -e.amountCents,
        fundingSource: e.fundingSource,
        releaseTo: e.releaseTo,
        reason: `Reversal of distribution No. ${number}: ${reason}`,
        reversesEntryId: e.id,
        createdById: by,
      },
    });
  }
  // FOUNDATION voids each offset receipt; its beforeVoidReceipt guard writes
  // the negating allocations and re-opens the lines and notices.
  for (const r of receipts) {
    await voidCapitalReceipt(
      tx,
      {
        companyId,
        receiptId: r.id,
        reason: `Distribution No. ${number} reversed: ${reason}`,
      },
      i.actor,
    );
  }

  // The ledger replays without the distribution and agrees with FOUNDATION.
  const { ledger } = await getPositions(
    tx,
    companyId,
    toDateOnly(original.paymentDate),
  );
  if (
    ledger.events.some(
      (e) => e.kind === "DISTRIBUTION" && e.distributionId === original.id,
    )
  ) {
    ledgerDisagrees("reversed distribution still in the ledger");
  }

  await audit(
    tx,
    i.actor,
    companyId,
    "distribution.reversed",
    [
      { type: "distribution", id: original.id },
      { type: "distribution", id: reversal.id },
    ],
    `${i.actor.name} reversed distribution No. ${number} (${formatCents(totals.amountCents)} gross, ${formatCents(totals.totalNetCents)} net) by distribution No. ${reversalNumber}: ${reason}. ${receipts.length} offset receipt(s) voided; books stay closed as they were.`,
  );

  return {
    id: original.id,
    number,
    reversalId: reversal.id,
    reversalNumber,
  };
}
