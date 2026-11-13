import "server-only";

import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { LlcEconomicsConfig } from "@/lib/llc/config";
import type { IsoDate } from "@/lib/llc/dates";
import {
  type BalanceReduction,
  type CreditProposal,
  computeCreditAllocation,
  computeForfeiture,
  forfeitureDate as computeForfeitureDate,
  defaultInterest,
  type ForfeitureProposal,
  outstandingBalance,
  replacementWindow,
} from "@/lib/llc/default";
import {
  type Cents,
  LlcMathError,
  type MicroUnits,
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import type { DefaultOwed } from "@/lib/llc/waterfall";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import {
  createCommitment,
  decideCommitment,
  type LedgerActor,
  recordCapitalReceipt,
  reduceAcceptedCommitment,
} from "@/server/llc/commitments";
import { unitsToWire } from "@/server/llc/serialize";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import {
  getCommitmentStates,
  reconcileCallNoticeLines,
  settleNotices,
} from "./call-notices";
import {
  type ActiveCommitment,
  blockingDefaultSteps,
  buildReductions,
  type DefaultAction,
  type DefaultEvaluation,
  type DefaultPaymentPlan,
  type DefaultStage,
  declarationErrors,
  defaultStage,
  evaluateDefault,
  forfeitureAvailableOn,
  fundingErrors,
  livePayments,
  type OtherDefault,
  pendingDefaultSteps,
  planCreditTargets,
  planDefaultPayment,
} from "./defaults.logic";
import { getPositions } from "./ledger";
import {
  conflict,
  lockCompanyLedger,
  lockCompanyLedgerAndUnitClasses,
  notFound,
  ruleViolation,
} from "./scope";
import { assertLedgerDateOpen, getEconomicsContext } from "./term";

/*
 * Default workflow (R30–R38, OA §4.9) as a confirmed-step state machine. One
 * MemberDefault per Call Notice line. Nothing punitive is automatic (R38):
 * declaring, forfeiture, credit and cure are each a Manager action on a
 * proposal recomputed inside the confirming transaction; a mismatch with
 * what the Manager saw is CONFLICT. Holdings change only through
 * FOUNDATION's services (commitments.ts). Every mutation takes the company
 * ledger lock first (then FOUNDATION takes its unit-class lock inside its
 * services) and re-reads the default after it.
 */

type Tx = PrismaTransactionalClient;
type Reader = TPrismaOrTransaction;
type Company = { id: string; timezone: string };

const ZERO_POSITION = {
  contributed: 0n,
  unreturned: 0n,
  unpaidReturn: 0n,
  preferredUnits: 0n,
};

function minBig(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}

function dateOrNull(d: Date | null): IsoDate | null {
  return d === null ? null : toDateOnly(d);
}

function createdBy(actor: LedgerActor): string {
  return actor.memberId ?? actor.userId;
}

/** Runs pure library code; an LlcMathError becomes a BAD_REQUEST. */
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

function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2025"
  );
}

/** A FOUNDATION service returned something other than what was proposed: roll back. */
function ledgerDisagrees(what: string): never {
  throw new Error(
    `Ledger write did not match the confirmed proposal (${what}); nothing was saved.`,
  );
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

async function companyOf(tx: Reader, companyId: string): Promise<Company> {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  return company;
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
// Loading

async function loadDefaultRecords(
  tx: Reader,
  companyId: string,
  filter?: { id?: string; excludeVoided?: boolean },
) {
  const defaults = await tx.memberDefault.findMany({
    where: {
      companyId,
      ...(filter?.id ? { id: filter.id } : {}),
      ...(filter?.excludeVoided ? { status: { not: "VOIDED" as const } } : {}),
    },
    orderBy: [{ dueOn: "asc" }, { declaredAt: "asc" }, { id: "asc" }],
    include: {
      callNoticeLine: {
        select: {
          id: true,
          callNoticeId: true,
          amountCalledCents: true,
          status: true,
          dueOn: true,
          callNotice: { select: { number: true } },
        },
      },
      fundings: {
        where: { companyId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      payments: {
        where: { companyId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      charges: {
        where: { companyId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      credits: {
        where: { companyId },
        orderBy: [{ clause: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (defaults.length === 0) return [];
  const allocations = await tx.callNoticeAllocation.findMany({
    where: {
      companyId,
      callNoticeLineId: { in: defaults.map((d) => d.callNoticeLineId) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      callNoticeLineId: true,
      amountCents: true,
      receivedOn: true,
      reversesAllocationId: true,
    },
  });
  return defaults.map((d) => ({
    ...d,
    allocations: allocations
      .filter((a) => a.callNoticeLineId === d.callNoticeLineId)
      .map((a) => ({
        id: a.id,
        amount: a.amountCents,
        receivedOn: toDateOnly(a.receivedOn),
        reversesAllocationId: a.reversesAllocationId,
      })),
  }));
}

type DefaultRecord = Awaited<ReturnType<typeof loadDefaultRecords>>[number];

async function loadDefault(
  tx: Reader,
  companyId: string,
  id: string,
): Promise<DefaultRecord> {
  const [record] = await loadDefaultRecords(tx, companyId, { id });
  if (!record) notFound("Default");
  return record;
}

function fundingRows(r: DefaultRecord) {
  return r.fundings.map((f) => ({
    id: f.id,
    funderStakeholderId: f.funderStakeholderId,
    funderCommitmentId: f.funderCommitmentId,
    funderIsInsider: f.funderIsInsider,
    amount: f.amountCents,
    fundedOn: toDateOnly(f.fundedOn),
  }));
}

function storedForfeiture(r: DefaultRecord) {
  if (r.forfeitureConfirmedAt === null) return null;
  if (
    r.forfeitedOn === null ||
    r.unpaidAtForfeitureCents === null ||
    r.forfeitedAmountCents === null
  ) {
    throw new Error(
      `Default ${r.id}: forfeiture confirmed without its figures.`,
    );
  }
  return {
    forfeitedOn: toDateOnly(r.forfeitedOn),
    unpaidAtForfeiture: r.unpaidAtForfeitureCents,
    forfeited: r.forfeitedAmountCents,
  };
}

function storedCredit(r: DefaultRecord) {
  if (r.creditConfirmedAt === null) return null;
  if (r.creditDate === null) {
    throw new Error(`Default ${r.id}: credit confirmed without its date.`);
  }
  return { creditDate: toDateOnly(r.creditDate) };
}

function evaluate(
  r: DefaultRecord,
  config: LlcEconomicsConfig,
  today: IsoDate,
  asOf: IsoDate = today,
): DefaultEvaluation {
  return math(() =>
    evaluateDefault(
      {
        status: r.status,
        dueOn: toDateOnly(r.dueOn),
        forfeitureDate: toDateOnly(r.forfeitureDate),
        amountCalled: r.callNoticeLine.amountCalledCents,
        allocations: r.allocations,
        fundings: fundingRows(r),
        payments: r.payments.map((p) => ({
          id: p.id,
          paidOn: toDateOnly(p.paidOn),
          toBalance: p.toBalanceCents,
          toInterest: p.toInterestCents,
          toCosts: p.toCostsCents,
        })),
        charges: r.charges.map((c) => ({
          id: c.id,
          incurredOn: toDateOnly(c.incurredOn),
          amount: c.amountCents,
        })),
        forfeiture: storedForfeiture(r),
        credit: storedCredit(r),
        cure:
          r.status === "CURED" && r.curedOn !== null && r.cureMethod !== null
            ? { curedOn: toDateOnly(r.curedOn), method: r.cureMethod }
            : null,
        today,
        asOf,
      },
      config,
    ),
  );
}

// ---------------------------------------------------------------------------
// Proposals

/** R33/R34: the member's position on the Forfeiture Date before the forfeiture. */
async function forfeitureProposal(
  tx: Reader,
  companyId: string,
  r: DefaultRecord,
  ev: DefaultEvaluation,
  config: LlcEconomicsConfig,
): Promise<ForfeitureProposal> {
  const fd = toDateOnly(r.forfeitureDate);
  const { positions } = await getPositions(tx, companyId, fd);
  const position = positions.holders.get(r.stakeholderId) ?? ZERO_POSITION;
  return math(() =>
    computeForfeiture(
      {
        unpaidAtDue: ev.unpaidAtDue,
        reductions: ev.reductions,
        forfeitureDate: fd,
        position,
      },
      config,
    ),
  );
}

/** R36: fundings on or before the Credit Date; Preferred holders on the due date except the Defaulting Member. */
async function creditProposal(
  tx: Reader,
  companyId: string,
  r: DefaultRecord,
  ev: DefaultEvaluation,
  config: LlcEconomicsConfig,
) {
  const stored = storedForfeiture(r);
  if (!stored) throw new Error("creditProposal before the forfeiture");
  const counted = fundingRows(r).filter(
    (f) => f.fundedOn <= ev.credit.creditDate,
  );
  const { positions } = await getPositions(tx, companyId, toDateOnly(r.dueOn));
  const holdersOnDueDate = [...positions.holders.values()]
    .filter((h) => h.holderId !== r.stakeholderId && h.preferredUnits > 0n)
    .map((h) => ({ holderId: h.holderId, units: h.preferredUnits }))
    .sort((a, b) =>
      a.holderId < b.holderId ? -1 : a.holderId > b.holderId ? 1 : 0,
    );
  const proposal: CreditProposal = math(() =>
    computeCreditAllocation(
      {
        forfeited: stored.forfeited,
        unpaidAtForfeiture: stored.unpaidAtForfeiture,
        fundings: counted.map((f) => ({
          holderId: f.funderStakeholderId,
          amount: f.amount,
          isInsider: f.funderIsInsider,
        })),
        holdersOnDueDate,
      },
      config,
    ),
  );
  return { proposal, counted, holdersOnDueDate };
}

// ---------------------------------------------------------------------------
// Views

export interface DefaultView {
  id: string;
  stakeholderId: string;
  memberName: string;
  commitmentId: string;
  callNoticeLineId: string;
  callNoticeId: string;
  callNoticeNumber: number;
  status: "OPEN" | "CURED" | "VOIDED";
  stage: DefaultStage;
  actions: {
    action: DefaultAction;
    availableOn: IsoDate;
    available: boolean;
  }[];
  dueOn: IsoDate;
  forfeitureDate: IsoDate;
  forfeitureAvailableOn: IsoDate;
  replacementWindow: { opensOn: IsoDate; closesOn: IsoDate };
  asOf: IsoDate;
  amountCalled: Cents;
  /** stored at declaration */
  declaredUnpaidAtDue: Cents;
  /** recomputed from the line's allocations (differs from the stored figure only if a receipt dated on or before the due date was voided since) */
  unpaidAtDue: Cents;
  reductions: BalanceReduction[];
  outstandingBalance: Cents;
  lastReductionBy: "MEMBER" | "REPLACEMENT_FUNDER" | null;
  fullyFundedOn: IsoDate | null;
  replacementFunded: Cents;
  memberPaidAfterDue: Cents;
  interestAccrued: Cents;
  interestPaid: Cents;
  interestOwed: Cents;
  costsCharged: Cents;
  costsPaid: Cents;
  costsOwed: Cents;
  forfeiture: {
    confirmed: boolean;
    due: boolean;
    available: boolean;
    paidInFullByForfeitureDate: boolean;
    /** computed while available; null otherwise */
    proposal: ForfeitureProposal | null;
    /** the stored stage-2 figures once confirmed */
    recorded: {
      forfeitedOn: IsoDate;
      unpaidAtForfeiture: Cents;
      capitalPaid: Cents | null;
      forfeited: Cents;
      unreturnedDeducted: Cents | null;
      extinguishedReturn: Cents | null;
      unitsBefore: MicroUnits | null;
      unitsAfter: MicroUnits | null;
      receiptId: string | null;
      confirmedAt: Date | null;
    } | null;
  };
  credit: {
    confirmed: boolean;
    creditDate: IsoDate | null;
    available: boolean;
    /** computed while available; null otherwise */
    proposal: CreditProposal | null;
    recorded: {
      creditDate: IsoDate;
      fundedAtCredit: Cents | null;
      poolA: Cents | null;
      redirected: Cents | null;
      poolB: Cents | null;
      confirmedAt: Date | null;
    } | null;
  };
  cure: {
    cured: boolean;
    method: "PAID_IN_FULL" | "REPLACEMENT_FUNDED" | null;
    curedOn: IsoDate | null;
    confirmed: boolean;
    blockedByForfeiture: boolean;
  };
  suspendedToday: boolean;
  declaredAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  fundings: {
    id: string;
    funderStakeholderId: string;
    funderName: string;
    funderCommitmentId: string;
    funderIsInsider: boolean;
    amount: Cents;
    fundedOn: IsoDate;
    capitalReceiptId: string;
    createdAt: Date;
  }[];
  payments: {
    id: string;
    paidOn: IsoDate;
    source: "CASH" | "DISTRIBUTION_OFFSET";
    toBalance: Cents;
    toInterest: Cents;
    toCosts: Cents;
    capitalReceiptId: string | null;
    distributionLineId: string | null;
    reversesPaymentId: string | null;
    createdAt: Date;
  }[];
  charges: {
    id: string;
    incurredOn: IsoDate;
    amount: Cents;
    description: string;
    documentId: string | null;
    reversesChargeId: string | null;
    createdAt: Date;
  }[];
  credits: {
    id: string;
    stakeholderId: string;
    name: string;
    commitmentId: string;
    clause: "A" | "B";
    amount: Cents;
    units: MicroUnits;
    capitalReceiptId: string;
  }[];
}

export async function getDefaultView(
  tx: Reader,
  companyId: string,
  memberDefaultId: string,
  today: IsoDate,
  asOf: IsoDate = today,
): Promise<DefaultView> {
  const company = await companyOf(tx, companyId);
  const { config } = await getEconomicsContext(tx, company);
  const r = await loadDefault(tx, companyId, memberDefaultId);
  const ev = evaluate(r, config, today, asOf);
  const dueOn = toDateOnly(r.dueOn);
  const fd = toDateOnly(r.forfeitureDate);
  const names = await stakeholderNames(tx, companyId, [
    r.stakeholderId,
    ...r.fundings.map((f) => f.funderStakeholderId),
    ...r.credits.map((c) => c.stakeholderId),
  ]);
  const forfeitureNow = ev.forfeiture.available
    ? await forfeitureProposal(tx, companyId, r, ev, config)
    : null;
  const creditNow = ev.credit.available
    ? (await creditProposal(tx, companyId, r, ev, config)).proposal
    : null;
  const { stage, actions } = defaultStage(r.status, fd, ev);
  const stored = storedForfeiture(r);
  return {
    id: r.id,
    stakeholderId: r.stakeholderId,
    memberName: names.get(r.stakeholderId) ?? "",
    commitmentId: r.commitmentId,
    callNoticeLineId: r.callNoticeLineId,
    callNoticeId: r.callNoticeLine.callNoticeId,
    callNoticeNumber: r.callNoticeLine.callNotice.number,
    status: r.status,
    stage,
    actions,
    dueOn,
    forfeitureDate: fd,
    forfeitureAvailableOn: forfeitureAvailableOn(fd),
    replacementWindow: replacementWindow(dueOn, config),
    asOf,
    amountCalled: r.callNoticeLine.amountCalledCents,
    declaredUnpaidAtDue: r.unpaidAtDueCents,
    unpaidAtDue: ev.unpaidAtDue,
    reductions: ev.reductions,
    outstandingBalance: ev.outstanding,
    lastReductionBy: ev.lastReductionBy,
    fullyFundedOn: ev.fullyFundedOn,
    replacementFunded: ev.replacementFunded,
    memberPaidAfterDue: ev.memberPaidAfterDue,
    interestAccrued: ev.interestAccrued,
    interestPaid: ev.interestPaid,
    interestOwed: ev.interestOwed,
    costsCharged: ev.costsCharged,
    costsPaid: ev.costsPaid,
    costsOwed: ev.costsOwed,
    forfeiture: {
      confirmed: ev.forfeiture.confirmed,
      due: ev.forfeiture.due,
      available: ev.forfeiture.available,
      paidInFullByForfeitureDate: ev.forfeiture.paidInFullByForfeitureDate,
      proposal: forfeitureNow,
      recorded: stored
        ? {
            forfeitedOn: stored.forfeitedOn,
            unpaidAtForfeiture: stored.unpaidAtForfeiture,
            capitalPaid: r.capitalPaidAtForfeitureCents,
            forfeited: stored.forfeited,
            unreturnedDeducted: r.unreturnedDeductedCents,
            extinguishedReturn: r.extinguishedReturnCents,
            unitsBefore:
              r.unitsBefore === null
                ? null
                : microUnitsFromDecimal(unitsToWire(r.unitsBefore)),
            unitsAfter:
              r.unitsAfter === null
                ? null
                : microUnitsFromDecimal(unitsToWire(r.unitsAfter)),
            receiptId: r.forfeitureReceiptId,
            confirmedAt: r.forfeitureConfirmedAt,
          }
        : null,
    },
    credit: {
      confirmed: ev.credit.confirmed,
      creditDate: ev.credit.creditDate,
      available: ev.credit.available,
      proposal: creditNow,
      recorded:
        r.creditConfirmedAt !== null && r.creditDate !== null
          ? {
              creditDate: toDateOnly(r.creditDate),
              fundedAtCredit: r.fundedAtCreditCents,
              poolA: r.creditPoolACents,
              redirected: r.creditRedirectedCents,
              poolB: r.creditPoolBCents,
              confirmedAt: r.creditConfirmedAt,
            }
          : null,
    },
    cure: {
      cured: ev.cure.cured,
      method: ev.cure.method,
      curedOn: ev.cure.curedOn,
      confirmed: ev.cure.confirmed,
      blockedByForfeiture: ev.cure.blockedByForfeiture,
    },
    suspendedToday: ev.suspended,
    declaredAt: r.declaredAt,
    voidedAt: r.voidedAt,
    voidReason: r.voidReason,
    fundings: r.fundings.map((f) => ({
      id: f.id,
      funderStakeholderId: f.funderStakeholderId,
      funderName: names.get(f.funderStakeholderId) ?? "",
      funderCommitmentId: f.funderCommitmentId,
      funderIsInsider: f.funderIsInsider,
      amount: f.amountCents,
      fundedOn: toDateOnly(f.fundedOn),
      capitalReceiptId: f.capitalReceiptId,
      createdAt: f.createdAt,
    })),
    payments: r.payments.map((p) => ({
      id: p.id,
      paidOn: toDateOnly(p.paidOn),
      source: p.source,
      toBalance: p.toBalanceCents,
      toInterest: p.toInterestCents,
      toCosts: p.toCostsCents,
      capitalReceiptId: p.capitalReceiptId,
      distributionLineId: p.distributionLineId,
      reversesPaymentId: p.reversesPaymentId,
      createdAt: p.createdAt,
    })),
    charges: r.charges.map((c) => ({
      id: c.id,
      incurredOn: toDateOnly(c.incurredOn),
      amount: c.amountCents,
      description: c.description,
      documentId: c.documentId,
      reversesChargeId: c.reversesChargeId,
      createdAt: c.createdAt,
    })),
    credits: r.credits.map((c) => ({
      id: c.id,
      stakeholderId: c.stakeholderId,
      name: names.get(c.stakeholderId) ?? "",
      commitmentId: c.commitmentId,
      clause: c.clause,
      amount: c.amountCents,
      units: microUnitsFromDecimal(unitsToWire(c.units)),
      capitalReceiptId: c.capitalReceiptId,
    })),
  };
}

/** All defaults with headline numbers (`memberDefault.list`). */
export async function listDefaults(
  tx: Reader,
  companyId: string,
  today: IsoDate,
) {
  const company = await companyOf(tx, companyId);
  const { config } = await getEconomicsContext(tx, company);
  const records = await loadDefaultRecords(tx, companyId);
  const names = await stakeholderNames(
    tx,
    companyId,
    records.map((r) => r.stakeholderId),
  );
  return records.map((r) => {
    const ev = evaluate(r, config, today);
    const fd = toDateOnly(r.forfeitureDate);
    const { stage, actions } = defaultStage(r.status, fd, ev);
    return {
      id: r.id,
      stakeholderId: r.stakeholderId,
      memberName: names.get(r.stakeholderId) ?? "",
      commitmentId: r.commitmentId,
      callNoticeLineId: r.callNoticeLineId,
      callNoticeId: r.callNoticeLine.callNoticeId,
      callNoticeNumber: r.callNoticeLine.callNotice.number,
      status: r.status,
      stage,
      actions,
      dueOn: toDateOnly(r.dueOn),
      forfeitureDate: fd,
      creditDate: ev.credit.creditDate,
      curedOn: ev.cure.curedOn,
      unpaidAtDue: ev.unpaidAtDue,
      outstandingBalance: ev.outstanding,
      interestOwed: ev.interestOwed,
      costsOwed: ev.costsOwed,
      replacementFunded: ev.replacementFunded,
      suspendedToday: ev.suspended,
    };
  });
}

/** SENT Call Notice lines past due, money outstanding, no MemberDefault row (voided included: a line can be declared once). */
export async function getOverdueUndeclared(
  tx: Reader,
  companyId: string,
  today: IsoDate,
): Promise<
  {
    lineId: string;
    callNoticeId: string;
    callNoticeNumber: number;
    stakeholderId: string;
    commitmentId: string;
    name: string;
    amountCalled: Cents;
    dueOn: IsoDate;
    /** what `declare` stores and compares with `expectedUnpaidCents` */
    unpaidAtDue: Cents;
    /** unpaidAtDue less late payments already received */
    outstanding: Cents;
    interestToDate: Cents;
    forfeitureDate: IsoDate;
    replacementWindow: { opensOn: IsoDate; closesOn: IsoDate };
  }[]
> {
  const company = await companyOf(tx, companyId);
  const { config } = await getEconomicsContext(tx, company);
  const lines = await tx.callNoticeLine.findMany({
    where: {
      companyId,
      status: "SENT",
      dueOn: { lt: fromDateOnly(today) },
      memberDefault: { is: null },
    },
    orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      callNoticeId: true,
      stakeholderId: true,
      commitmentId: true,
      amountCalledCents: true,
      dueOn: true,
      callNotice: { select: { number: true } },
    },
  });
  if (lines.length === 0) return [];
  const allocations = await tx.callNoticeAllocation.findMany({
    where: { companyId, callNoticeLineId: { in: lines.map((l) => l.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      callNoticeLineId: true,
      amountCents: true,
      receivedOn: true,
      reversesAllocationId: true,
    },
  });
  const names = await stakeholderNames(
    tx,
    companyId,
    lines.map((l) => l.stakeholderId),
  );
  const out = [];
  for (const l of lines) {
    if (l.dueOn === null) continue;
    const dueOn = toDateOnly(l.dueOn);
    const { paidByDue, reductions } = math(() =>
      buildReductions(
        allocations
          .filter((a) => a.callNoticeLineId === l.id)
          .map((a) => ({
            id: a.id,
            amount: a.amountCents,
            receivedOn: toDateOnly(a.receivedOn),
            reversesAllocationId: a.reversesAllocationId,
          })),
        [],
        dueOn,
      ),
    );
    const unpaidAtDue = l.amountCalledCents - paidByDue;
    const outstanding = math(() =>
      outstandingBalance(unpaidAtDue, reductions, today),
    );
    if (outstanding <= 0n) continue;
    out.push({
      lineId: l.id,
      callNoticeId: l.callNoticeId,
      callNoticeNumber: l.callNotice.number,
      stakeholderId: l.stakeholderId,
      commitmentId: l.commitmentId,
      name: names.get(l.stakeholderId) ?? "",
      amountCalled: l.amountCalledCents,
      dueOn,
      unpaidAtDue,
      outstanding,
      interestToDate: math(() =>
        defaultInterest(
          { unpaidAtDue, dueOn, reductions, asOf: today },
          config,
        ),
      ),
      forfeitureDate: computeForfeitureDate(dueOn, config),
      replacementWindow: replacementWindow(dueOn, config),
    });
  }
  return out;
}

/**
 * For the distribution run (E15), as of `asOf` (the payment date): per
 * stakeholder, every non-voided default still suspended on `asOf` plus
 * CURED defaults that still owe interest or costs (R17, R18).
 */
export async function getDefaultsOwed(
  tx: Reader,
  companyId: string,
  asOf: IsoDate,
): Promise<Map<string, DefaultOwed[]>> {
  const company = await companyOf(tx, companyId);
  const { config, today } = await getEconomicsContext(tx, company);
  const records = await loadDefaultRecords(tx, companyId, {
    excludeVoided: true,
  });
  const out = new Map<string, DefaultOwed[]>();
  for (const r of records) {
    const ev = evaluate(r, config, today, asOf);
    if (!ev.suspended && ev.interestOwed === 0n && ev.costsOwed === 0n)
      continue;
    const owed: DefaultOwed = {
      memberDefaultId: r.id,
      dueOn: toDateOnly(r.dueOn),
      suspended: ev.suspended,
      balance: minBig(ev.outstanding, ev.lineOutstanding),
      interest: ev.interestOwed,
      costs: ev.costsOwed,
      cureNeedsConfirmation: ev.cureNeedsConfirmation,
    };
    const list = out.get(r.stakeholderId) ?? [];
    list.push(owed);
    out.set(r.stakeholderId, list);
  }
  return out;
}

/**
 * E15 PENDING_DEFAULT_STEP: default steps that must be confirmed before a
 * distribution paid on `paymentDate` can be finalized (evaluated today).
 */
export async function getPendingDefaultSteps(
  tx: Reader,
  companyId: string,
  paymentDate: IsoDate,
): Promise<
  {
    memberDefaultId: string;
    stakeholderId: string;
    name: string;
    steps: ("FORFEITURE" | "CREDIT" | "CURE")[];
    message: string;
  }[]
> {
  const company = await companyOf(tx, companyId);
  const { config, today } = await getEconomicsContext(tx, company);
  const records = await loadDefaultRecords(tx, companyId, {
    excludeVoided: true,
  });
  const names = await stakeholderNames(
    tx,
    companyId,
    records.map((r) => r.stakeholderId),
  );
  const out = [];
  for (const r of records) {
    const ev = evaluate(r, config, today);
    const steps = pendingDefaultSteps(
      r.status,
      toDateOnly(r.forfeitureDate),
      ev,
      paymentDate,
    );
    if (steps.length === 0) continue;
    const name = names.get(r.stakeholderId) ?? "";
    const label: Record<(typeof steps)[number], string> = {
      FORFEITURE: `forfeiture (Forfeiture Date ${toDateOnly(r.forfeitureDate)})`,
      CREDIT: `credit (Credit Date ${ev.credit.creditDate})`,
      CURE: "cure",
    };
    out.push({
      memberDefaultId: r.id,
      stakeholderId: r.stakeholderId,
      name,
      steps,
      message: `Confirm the ${steps.map((s) => label[s]).join(", ")} of ${name}'s default first (Section 4.9).`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutations (each runs inside the caller's transaction)

type MutationInput = { company: Company; actor: LedgerActor };

/**
 * After the locks: re-reads the default and the economics context. The unit
 * class locks are taken too (advisory lock first): the proposals read
 * positions, and FOUNDATION's own receipt writes take only the class lock.
 */
async function lockedDefault(tx: Tx, company: Company, id: string) {
  await lockCompanyLedgerAndUnitClasses(tx, company.id);
  const ctx = await getEconomicsContext(tx, company);
  const record = await loadDefault(tx, company.id, id);
  return { ...ctx, record };
}

/**
 * Refuses while another default has a forfeiture or credit, effective on or
 * before `readsOn`, that is not yet in the ledger: the positions this
 * confirmation freezes would be wrong (see `blockingDefaultSteps`).
 */
async function assertEarlierStepsConfirmed(
  tx: Reader,
  companyId: string,
  config: LlcEconomicsConfig,
  today: IsoDate,
  record: DefaultRecord,
  step: "FORFEITURE" | "CREDIT",
  readsOn: IsoDate,
): Promise<void> {
  const records = await loadDefaultRecords(tx, companyId, {
    excludeVoided: true,
  });
  const others: OtherDefault[] = records.map((r, seq) => ({
    id: r.id,
    stakeholderId: r.stakeholderId,
    status: r.status,
    forfeitureDate: toDateOnly(r.forfeitureDate),
    seq,
    ev: evaluate(r, config, today),
  }));
  const self = others.find((o) => o.id === record.id);
  const blocking = blockingDefaultSteps({
    self: {
      id: record.id,
      stakeholderId: record.stakeholderId,
      seq: self?.seq ?? Number.MAX_SAFE_INTEGER,
    },
    step,
    readsOn,
    others,
  });
  if (blocking.length === 0) return;
  const byId = new Map(records.map((r) => [r.id, r]));
  const names = await stakeholderNames(
    tx,
    companyId,
    blocking.map((b) => byId.get(b.id)?.stakeholderId ?? ""),
  );
  const list = blocking
    .map(
      (b) =>
        `the ${b.step === "FORFEITURE" ? "forfeiture" : "credit"} of ${names.get(byId.get(b.id)?.stakeholderId ?? "") ?? "another member"}'s default (effective ${b.on})`,
    )
    .join("; ");
  ruleViolation(
    `Confirm ${list} first: it changes the holdings on ${readsOn} that this step is computed from (Section 4.9(iv)).`,
  );
}

/** update with a guard in `where`; a guard that no longer holds is CONFLICT. */
async function guardedUpdate(
  run: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isRecordNotFound(error)) conflict(message);
    throw error;
  }
}

/** The line becomes PAID once nothing is outstanding; its notice may settle. */
async function closeLineIfPaid(
  tx: Tx,
  companyId: string,
  record: DefaultRecord,
  ev: DefaultEvaluation,
): Promise<void> {
  if (ev.lineOutstanding !== 0n || ev.lineSettledOn === null) return;
  // Read after the ledger lock: an interest-only payment on a line already
  // PAID leaves it as it is.
  if (record.callNoticeLine.status !== "SENT") return;
  await tx.callNoticeLine.update({
    where: { id: record.callNoticeLineId, companyId, status: "SENT" },
    data: { status: "PAID", paidInFullOn: fromDateOnly(ev.lineSettledOn) },
  });
  await settleNotices(tx, companyId, [record.callNoticeLine.callNoticeId]);
}

/**
 * Refuses while the commitment holds Balance money that is applied to no
 * Call Notice line: a receipt recorded on FOUNDATION's Commitments page
 * (plain `recordCapitalReceipt`) instead of through "Record payment". The
 * default figures count only allocations, so such money would be ignored and
 * the member treated as not having paid (declaring, forfeiting on the full
 * unpaid Balance, or a Replacement Funder funding money already paid).
 */
async function assertNoUnappliedBalanceMoney(
  tx: Reader,
  companyId: string,
  commitmentId: string,
  declared: boolean,
): Promise<void> {
  const [state] = await getCommitmentStates(tx, companyId, {
    commitmentIds: [commitmentId],
  });
  if (!state || state.prepaidUnallocated <= 0n) return;
  ruleViolation(
    `${state.name} has ${formatCents(state.prepaidUnallocated)} of Balance money recorded that is not applied to any Call Notice line, so this Balance may already be paid in part (Section 4.9). Void that receipt on the member's Commitments tab and record it again with "Record payment" on ${declared ? "the default page" : "the Call Notice"}, then review again.`,
  );
}

/**
 * Before a line is judged overdue, applies the member's Balance money that a
 * failed post-send match left unapplied (`reconcileCallNoticeLines`, under
 * the advisory and Preferred class locks). The `declare` procedure runs this
 * in its own transaction first, so a match that shows the member paid is
 * kept even though the declaration that follows is refused; `declareDefault`
 * runs it again inside its own transaction.
 */
export async function reconcileBeforeDeclare(
  tx: Tx,
  i: MutationInput & { callNoticeLineId: string },
): Promise<void> {
  const companyId = i.company.id;
  await lockCompanyLedger(tx, companyId);
  const line = await tx.callNoticeLine.findFirst({
    where: { id: i.callNoticeLineId, companyId },
    select: { commitmentId: true },
  });
  if (!line) notFound("Call Notice line");
  await reconcileCallNoticeLines(tx, companyId, line.commitmentId, i.actor);
}

export async function declareDefault(
  tx: Tx,
  i: MutationInput & { callNoticeLineId: string; expectedUnpaidCents: Cents },
) {
  const companyId = i.company.id;
  // Prepaid money is applied first (B2): a member who has paid is never
  // declared in default. Everything below is read after it.
  await reconcileBeforeDeclare(tx, i);
  const { config, today } = await getEconomicsContext(tx, i.company);
  const line = await tx.callNoticeLine.findFirst({
    where: { id: i.callNoticeLineId, companyId },
    select: {
      id: true,
      callNoticeId: true,
      stakeholderId: true,
      commitmentId: true,
      amountCalledCents: true,
      status: true,
      dueOn: true,
      callNotice: { select: { number: true } },
      memberDefault: { select: { id: true } },
    },
  });
  if (!line) notFound("Call Notice line");
  const dueOn = dateOrNull(line.dueOn);
  const allocations = await tx.callNoticeAllocation.findMany({
    where: { companyId, callNoticeLineId: line.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      amountCents: true,
      receivedOn: true,
      reversesAllocationId: true,
    },
  });
  const { paidByDue, reductions } = math(() =>
    buildReductions(
      allocations.map((a) => ({
        id: a.id,
        amount: a.amountCents,
        receivedOn: toDateOnly(a.receivedOn),
        reversesAllocationId: a.reversesAllocationId,
      })),
      [],
      dueOn ?? today,
    ),
  );
  const unpaidAtDue = line.amountCalledCents - paidByDue;
  const outstanding = math(() =>
    outstandingBalance(unpaidAtDue, reductions, today),
  );
  const errors = declarationErrors({
    lineStatus: line.status,
    dueOn,
    today,
    hasDefault: line.memberDefault !== null,
    outstanding,
  });
  if (errors.length > 0 || dueOn === null) ruleViolation(errors.join(" "));
  // Balance money recorded outside the Call Notice flow (FOUNDATION's
  // Commitments page) is not matched to any line, so the line looks unpaid
  // although the member paid. Refuse until it is applied to the line.
  await assertNoUnappliedBalanceMoney(tx, companyId, line.commitmentId, false);
  if (unpaidAtDue !== i.expectedUnpaidCents) {
    conflict(
      `The amount unpaid at the due date is now ${formatCents(unpaidAtDue)}, not ${formatCents(i.expectedUnpaidCents)}; review and confirm again.`,
    );
  }
  const fd = computeForfeitureDate(dueOn, config);
  const created = await tx.memberDefault.create({
    data: {
      companyId,
      callNoticeLineId: line.id,
      stakeholderId: line.stakeholderId,
      commitmentId: line.commitmentId,
      status: "OPEN",
      dueOn: fromDateOnly(dueOn),
      unpaidAtDueCents: unpaidAtDue,
      forfeitureDate: fromDateOnly(fd),
      declaredById: createdBy(i.actor),
    },
    select: { id: true },
  });
  const names = await stakeholderNames(tx, companyId, [line.stakeholderId]);
  const window = replacementWindow(dueOn, config);
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.declared",
    [
      { type: "memberDefault", id: created.id },
      { type: "callNotice", id: line.callNoticeId },
      { type: "stakeholder", id: line.stakeholderId },
    ],
    `${i.actor.name} declared ${names.get(line.stakeholderId) ?? "a member"} a Defaulting Member under Section 4.9 on Call Notice No. ${line.callNotice.number}: ${formatCents(unpaidAtDue)} unpaid at the due date ${dueOn}${
      outstanding !== unpaidAtDue
        ? ` (${formatCents(outstanding)} still outstanding)`
        : ""
    }; interest at ${config.defaultInterestBps / 100}% from ${dueOn}; Forfeiture Date ${fd}; Replacement Funders ${window.opensOn} to ${window.closesOn}.`,
  );
  return { id: created.id, dueOn, unpaidAtDue, forfeitureDate: fd };
}

export async function voidDefault(
  tx: Tx,
  i: MutationInput & { id: string; reason: string },
) {
  const companyId = i.company.id;
  const { record } = await lockedDefault(tx, i.company, i.id);
  if (record.status !== "OPEN")
    ruleViolation("Only an open default can be voided.");
  if (record.fundings.length > 0 || livePayments(record.payments).length > 0) {
    ruleViolation(
      "A default with Replacement Funder fundings or payments cannot be voided.",
    );
  }
  if (record.forfeitureConfirmedAt !== null) {
    ruleViolation("A default whose forfeiture was confirmed cannot be voided.");
  }
  await guardedUpdate(
    () =>
      tx.memberDefault.update({
        where: {
          id: record.id,
          companyId,
          status: "OPEN",
          forfeitureConfirmedAt: null,
        },
        data: {
          status: "VOIDED",
          voidedAt: new Date(),
          voidedById: createdBy(i.actor),
          voidReason: i.reason,
        },
      }),
    "The default changed; reload and try again.",
  );
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.voided",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
    ],
    `${i.actor.name} voided the default due ${toDateOnly(record.dueOn)} on Call Notice No. ${record.callNoticeLine.callNotice.number}: ${i.reason}.`,
  );
  return { id: record.id };
}

export async function addDefaultCharge(
  tx: Tx,
  i: MutationInput & {
    id: string;
    incurredOn: IsoDate;
    amountCents: Cents;
    description: string;
    documentId?: string;
  },
) {
  const companyId = i.company.id;
  const { record, today } = await lockedDefault(tx, i.company, i.id);
  if (record.status === "VOIDED") ruleViolation("This default was voided.");
  const dueOn = toDateOnly(record.dueOn);
  if (i.incurredOn < dueOn || i.incurredOn > today) {
    ruleViolation(
      `Costs of collection are dated from the due date ${dueOn} to today (Section 4.9(v)).`,
    );
  }
  if (i.amountCents <= 0n) ruleViolation("The amount must be more than zero.");
  if (i.documentId) {
    await assertCompanyOwns(
      tx,
      companyId,
      { documentIds: [i.documentId] },
      () => notFound("Document"),
    );
  }
  const charge = await tx.memberDefaultCharge.create({
    data: {
      companyId,
      memberDefaultId: record.id,
      incurredOn: fromDateOnly(i.incurredOn),
      amountCents: i.amountCents,
      description: i.description,
      documentId: i.documentId ?? null,
      createdById: createdBy(i.actor),
    },
    select: { id: true },
  });
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.charge-added",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
    ],
    `${i.actor.name} charged ${formatCents(i.amountCents)} of costs of collection incurred ${i.incurredOn} to the default due ${dueOn} (Section 4.9(v)): ${i.description}.`,
  );
  return { id: charge.id };
}

export async function recordDefaultFunding(
  tx: Tx,
  i: MutationInput & {
    id: string;
    funderStakeholderId: string;
    amountCents: Cents;
    fundedOn: IsoDate;
    reference?: string;
  },
) {
  const companyId = i.company.id;
  const { record, config, today, preferredClass } = await lockedDefault(
    tx,
    i.company,
    i.id,
  );
  await assertCompanyOwns(
    tx,
    companyId,
    { stakeholderIds: [i.funderStakeholderId] },
    () => notFound("Replacement Funder"),
  );
  const funder = await tx.stakeholder.findFirst({
    where: { id: i.funderStakeholderId, companyId },
    select: { id: true, name: true, isInsider: true },
  });
  if (!funder) notFound("Replacement Funder");
  const ev = evaluate(record, config, today);
  const dueOn = toDateOnly(record.dueOn);
  const window = replacementWindow(dueOn, config);
  const outstandingAtFundedOn = math(() =>
    outstandingBalance(ev.unpaidAtDue, ev.reductions, i.fundedOn),
  );
  const errors = fundingErrors({
    status: record.status,
    today,
    fundedOn: i.fundedOn,
    window,
    amount: i.amountCents,
    outstandingAtFundedOn,
    outstandingNow: ev.lineOutstanding,
    funderIsDefaulter: funder.id === record.stakeholderId,
    funderIsInsider: funder.isInsider,
    earlierTranchesInsider: record.fundings
      .filter((f) => f.funderStakeholderId === funder.id)
      .map((f) => f.funderIsInsider),
    forfeiture: storedForfeiture(record),
    credit: storedCredit(record),
    forfeitureBaseNetOfReplacementFunding:
      config.forfeitureBaseNetOfReplacementFunding,
    interestPaymentDates: livePayments(record.payments)
      .filter((p) => p.toInterestCents > 0n)
      .map((p) => toDateOnly(p.paidOn)),
  });
  if (errors.length > 0) ruleViolation(errors.join(" "));
  await assertLedgerDateOpen(tx, companyId, i.fundedOn);
  // A funding reduces the Defaulting Member's commitment for good: it must
  // not fund Balance the member has already paid.
  await assertNoUnappliedBalanceMoney(tx, companyId, record.commitmentId, true);

  const names = await stakeholderNames(tx, companyId, [record.stakeholderId]);
  const memberName = names.get(record.stakeholderId) ?? "the Defaulting Member";
  const noticeNumber = record.callNoticeLine.callNotice.number;

  // R31 order: reduce the defaulter first (offering cap), then create and
  // accept the Replacement commitment, then record its REPLACEMENT receipt.
  await reduceAcceptedCommitment(
    tx,
    {
      companyId,
      commitmentId: record.commitmentId,
      reduceByCents: i.amountCents,
      reason: "Section 4.9(ii): funded by Replacement Funder",
    },
    i.actor,
  );
  const commitment = await createCommitment(
    tx,
    {
      companyId,
      stakeholderId: funder.id,
      unitClassId: preferredClass.id,
      committedCents: i.amountCents,
      signedOn: i.fundedOn,
      isReplacement: true,
      notes: `Replacement Funder for ${memberName}, Call Notice No. ${noticeNumber}`,
    },
    i.actor,
  );
  const accepted = await decideCommitment(
    tx,
    {
      companyId,
      commitmentId: commitment.id,
      decision: "ACCEPT",
      acceptedCents: i.amountCents,
      acceptedOn: i.fundedOn,
      skipClosingDateCheck: true,
    },
    i.actor,
  );
  if (
    accepted.status !== "ACCEPTED" ||
    accepted.acceptedCents !== i.amountCents
  ) {
    ledgerDisagrees("Replacement commitment not accepted in full");
  }
  const receipt = await recordCapitalReceipt(
    tx,
    {
      companyId,
      commitmentId: commitment.id,
      receivedOn: i.fundedOn,
      amountCents: i.amountCents,
      reference: i.reference,
      sourceType: "memberDefault",
      sourceId: record.id,
      special: { kind: "REPLACEMENT", appliedCents: i.amountCents },
    },
    i.actor,
  );
  if (
    receipt.kind !== "REPLACEMENT" ||
    receipt.appliedCents !== i.amountCents ||
    dateOrNull(receipt.appliedOn) !== i.fundedOn
  ) {
    ledgerDisagrees("REPLACEMENT receipt");
  }
  const funding = await tx.memberDefaultFunding.create({
    data: {
      companyId,
      memberDefaultId: record.id,
      funderStakeholderId: funder.id,
      funderCommitmentId: commitment.id,
      funderIsInsider: funder.isInsider,
      amountCents: i.amountCents,
      fundedOn: fromDateOnly(i.fundedOn),
      capitalReceiptId: receipt.id,
      createdById: createdBy(i.actor),
    },
    select: { id: true },
  });
  const after = evaluate(
    await loadDefault(tx, companyId, record.id),
    config,
    today,
  );
  await closeLineIfPaid(tx, companyId, record, after);
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.funding-recorded",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
      { type: "stakeholder", id: funder.id },
      { type: "commitment", id: record.commitmentId },
      { type: "commitment", id: commitment.id },
      { type: "capitalReceipt", id: receipt.id },
    ],
    `${i.actor.name} recorded ${formatCents(i.amountCents)} funded on ${i.fundedOn} by ${funder.name}${funder.isInsider ? " (insider)" : ""} as Replacement Funder for ${memberName} (Call Notice No. ${noticeNumber}, Section 4.9(ii)); ${memberName}'s commitment reduced by the same amount; unpaid Balance now ${formatCents(after.lineOutstanding)}.`,
  );
  return {
    id: funding.id,
    funderCommitmentId: commitment.id,
    capitalReceiptId: receipt.id,
    outstandingBalance: after.lineOutstanding,
  };
}

/** The split a payment dated `paidOn` would get (shared by the preview and the mutation). */
function paymentPlanFor(
  record: DefaultRecord,
  config: LlcEconomicsConfig,
  today: IsoDate,
  paidOn: IsoDate,
  amount: Cents,
): DefaultPaymentPlan {
  const now = evaluate(record, config, today);
  const atPayment = evaluate(record, config, today, paidOn);
  const latestPaymentOn = livePayments(record.payments).reduce<IsoDate | null>(
    (latest, p) => {
      const d = toDateOnly(p.paidOn);
      return latest === null || d > latest ? d : latest;
    },
    null,
  );
  return math(() =>
    planDefaultPayment({
      status: record.status,
      dueOn: toDateOnly(record.dueOn),
      paidOn,
      today,
      amount,
      figures: atPayment,
      lineOutstandingNow: now.lineOutstanding,
      latestPaymentOn,
      forfeiture: storedForfeiture(record),
      credit: storedCredit(record),
      order: config.defaultOffsetOrder,
    }),
  );
}

/**
 * Read-only: how `recordPayment` would split `amountCents` paid on `paidOn`
 * (the `expected` the Manager confirms, R38), with any refusal reasons.
 */
export async function previewDefaultPayment(
  tx: Reader,
  companyId: string,
  i: { id: string; paidOn: IsoDate; amountCents: Cents },
) {
  const company = await companyOf(tx, companyId);
  const { config, today } = await getEconomicsContext(tx, company);
  const record = await loadDefault(tx, companyId, i.id);
  const plan = paymentPlanFor(record, config, today, i.paidOn, i.amountCents);
  return {
    today,
    paidOn: i.paidOn,
    amount: i.amountCents,
    order: config.defaultOffsetOrder,
    owed: plan.owed,
    toBalance: plan.toBalance,
    toInterest: plan.toInterest,
    toCosts: plan.toCosts,
    errors: plan.errors,
  };
}

export async function recordDefaultPayment(
  tx: Tx,
  i: MutationInput & {
    id: string;
    paidOn: IsoDate;
    amountCents: Cents;
    expected: {
      toBalanceCents: Cents;
      toInterestCents: Cents;
      toCostsCents: Cents;
    };
  },
) {
  const companyId = i.company.id;
  const { record, config, today } = await lockedDefault(tx, i.company, i.id);
  const dueOn = toDateOnly(record.dueOn);
  const plan = paymentPlanFor(record, config, today, i.paidOn, i.amountCents);
  if (plan.errors.length > 0) ruleViolation(plan.errors.join(" "));
  if (
    plan.toBalance !== i.expected.toBalanceCents ||
    plan.toInterest !== i.expected.toInterestCents ||
    plan.toCosts !== i.expected.toCostsCents
  ) {
    conflict(
      `The payment would now be applied ${formatCents(plan.toBalance)} to Balance, ${formatCents(plan.toInterest)} to interest and ${formatCents(plan.toCosts)} to costs; review and confirm again.`,
    );
  }
  // Interest and costs are not ledger events and may be paid on a payment
  // date; the Balance part is a receipt, refused there by the receipt guard.
  await assertLedgerDateOpen(tx, companyId, i.paidOn, { allowSameDay: true });

  let capitalReceiptId: string | null = null;
  if (plan.toBalance > 0n) {
    const receipt = await recordCapitalReceipt(
      tx,
      {
        companyId,
        commitmentId: record.commitmentId,
        receivedOn: i.paidOn,
        amountCents: plan.toBalance,
        dueDate: dueOn,
        note: `Late Balance payment on Call Notice No. ${record.callNoticeLine.callNotice.number} (Section 4.9)`,
        sourceType: "memberDefault",
        sourceId: record.id,
      },
      i.actor,
    );
    if (
      receipt.kind !== "BALANCE" ||
      receipt.appliedCents !== plan.toBalance ||
      dateOrNull(receipt.appliedOn) !== i.paidOn
    ) {
      ledgerDisagrees("BALANCE receipt");
    }
    capitalReceiptId = receipt.id;
    await tx.callNoticeAllocation.create({
      data: {
        companyId,
        callNoticeLineId: record.callNoticeLineId,
        capitalReceiptId: receipt.id,
        amountCents: plan.toBalance,
        receivedOn: fromDateOnly(i.paidOn),
        prefReturnStartOn: fromDateOnly(i.paidOn),
        source: "PAYMENT",
        createdById: createdBy(i.actor),
      },
    });
  }
  const payment = await tx.memberDefaultPayment.create({
    data: {
      companyId,
      memberDefaultId: record.id,
      paidOn: fromDateOnly(i.paidOn),
      source: "CASH",
      toBalanceCents: plan.toBalance,
      toInterestCents: plan.toInterest,
      toCostsCents: plan.toCosts,
      capitalReceiptId,
      createdById: createdBy(i.actor),
    },
    select: { id: true },
  });
  const reloaded = await loadDefault(tx, companyId, record.id);
  const after = evaluate(reloaded, config, today);
  await closeLineIfPaid(tx, companyId, record, after);
  const names = await stakeholderNames(tx, companyId, [record.stakeholderId]);
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.payment-recorded",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
      ...(capitalReceiptId
        ? [{ type: "capitalReceipt" as const, id: capitalReceiptId }]
        : []),
    ],
    `${i.actor.name} recorded ${formatCents(i.amountCents)} paid on ${i.paidOn} by ${names.get(record.stakeholderId) ?? "the Defaulting Member"} on the default due ${dueOn}: ${formatCents(plan.toBalance)} to Balance, ${formatCents(plan.toInterest)} to interest, ${formatCents(plan.toCosts)} to costs (order ${config.defaultOffsetOrder.join(", ")}, Section 4.9(iii)); unpaid Balance now ${formatCents(after.lineOutstanding)}${after.cure.cured ? "; the cure test is met (confirm the cure)" : ""}.`,
  );
  return {
    id: payment.id,
    capitalReceiptId,
    toBalance: plan.toBalance,
    toInterest: plan.toInterest,
    toCosts: plan.toCosts,
    outstandingBalance: after.lineOutstanding,
    cureAvailable: after.cure.cured,
  };
}

export async function confirmForfeiture(
  tx: Tx,
  i: MutationInput & {
    id: string;
    expectedForfeitedCents: Cents;
    expectedUnitsAfter: MicroUnits;
  },
) {
  const companyId = i.company.id;
  const { record, config, today } = await lockedDefault(tx, i.company, i.id);
  const fd = toDateOnly(record.forfeitureDate);
  if (record.status !== "OPEN")
    ruleViolation("Only an open default can forfeit.");
  if (record.forfeitureConfirmedAt !== null) {
    ruleViolation("The forfeiture was already confirmed.");
  }
  const ev = evaluate(record, config, today);
  if (today <= fd) {
    ruleViolation(
      `The forfeiture can be confirmed after the Forfeiture Date ${fd}; a cure on that date is in time (Section 4.9(iv)).`,
    );
  }
  if (ev.forfeiture.paidInFullByForfeitureDate || !ev.forfeiture.available) {
    ruleViolation(
      "The default was cured by payment on or before the Forfeiture Date; there is no forfeiture (Section 4.9(iv)).",
    );
  }
  await assertLedgerDateOpen(tx, companyId, fd);
  // The Forfeited Amount is irreversible: money the member paid must be in
  // the figures (it reduces the unpaid Balance at the Forfeiture Date).
  await assertNoUnappliedBalanceMoney(tx, companyId, record.commitmentId, true);
  await assertEarlierStepsConfirmed(
    tx,
    companyId,
    config,
    today,
    record,
    "FORFEITURE",
    fd,
  );
  const proposal = await forfeitureProposal(tx, companyId, record, ev, config);
  if (
    proposal.forfeited !== i.expectedForfeitedCents ||
    proposal.unitsAfter !== i.expectedUnitsAfter
  ) {
    conflict(
      `The Forfeited Amount is now ${formatCents(proposal.forfeited)} leaving ${microUnitsToDecimalString(proposal.unitsAfter)} Preferred Units; review and confirm again.`,
    );
  }

  let receiptId: string | null = null;
  if (proposal.forfeited > 0n) {
    const receipt = await recordCapitalReceipt(
      tx,
      {
        companyId,
        commitmentId: record.commitmentId,
        receivedOn: fd,
        amountCents: 0n,
        sourceType: "memberDefault",
        sourceId: record.id,
        special: { kind: "FORFEITURE", appliedCents: -proposal.forfeited },
      },
      i.actor,
    );
    const cancelled = -microUnitsFromDecimal(unitsToWire(receipt.unitsIssued));
    if (
      receipt.kind !== "FORFEITURE" ||
      receipt.appliedCents !== -proposal.forfeited ||
      dateOrNull(receipt.appliedOn) !== fd ||
      proposal.unitsBefore - cancelled !== proposal.unitsAfter
    ) {
      ledgerDisagrees("FORFEITURE receipt");
    }
    receiptId = receipt.id;
    // The ledger engine must reproduce the proposal (and FOUNDATION's
    // getMemberPositions must agree: getPositions cross-checks).
    const { positions } = await getPositions(tx, companyId, fd);
    const entry = positions.forfeitures
      .filter((f) => f.holderId === record.stakeholderId && f.on === fd)
      .at(-1);
    if (
      !entry ||
      entry.amount !== proposal.forfeited ||
      entry.unreturnedDeducted !== proposal.unreturnedDeducted ||
      entry.extinguishedReturn !== proposal.extinguishedReturn ||
      entry.unitsAfter !== proposal.unitsAfter
    ) {
      ledgerDisagrees("positions after the forfeiture");
    }
  }
  await guardedUpdate(
    () =>
      tx.memberDefault.update({
        where: {
          id: record.id,
          companyId,
          status: "OPEN",
          forfeitureConfirmedAt: null,
        },
        data: {
          forfeitedOn: fromDateOnly(fd),
          unpaidAtForfeitureCents: proposal.unpaidAtForfeiture,
          capitalPaidAtForfeitureCents: proposal.capitalPaid,
          forfeitedAmountCents: proposal.forfeited,
          forfeitureReceiptId: receiptId,
          unreturnedDeductedCents: proposal.unreturnedDeducted,
          extinguishedReturnCents: proposal.extinguishedReturn,
          unitsBefore: microUnitsToDecimalString(proposal.unitsBefore),
          unitsAfter: microUnitsToDecimalString(proposal.unitsAfter),
          forfeitureConfirmedAt: new Date(),
          forfeitureConfirmedById: createdBy(i.actor),
        },
      }),
    "The default changed; reload and try again.",
  );
  const names = await stakeholderNames(tx, companyId, [record.stakeholderId]);
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.forfeiture-confirmed",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
      ...(receiptId
        ? [{ type: "capitalReceipt" as const, id: receiptId }]
        : []),
    ],
    `${i.actor.name} confirmed the forfeiture of ${names.get(record.stakeholderId) ?? "the Defaulting Member"} effective ${fd} (Section 4.9(iv)): ${config.forfeitureBps / 100}% × ${formatCents(proposal.unpaidAtForfeiture)} unpaid${
      config.forfeitureBaseNetOfReplacementFunding
        ? " (net of Replacement Funder funding)"
        : " (not reduced by Replacement Funder funding)"
    } = ${formatCents(proposal.halfOfUnpaid)}; cap ${formatCents(proposal.capitalPaid)} (Capital Contributions paid)${proposal.capBinding ? " applies" : ""}; Forfeited Amount ${formatCents(proposal.forfeited)}; Unreturned Capital Contributions reduced ${formatCents(proposal.unreturnedDeducted)}; accrued Preferred Return extinguished ${formatCents(proposal.extinguishedReturn)}; Preferred Units ${microUnitsToDecimalString(proposal.unitsBefore)} → ${microUnitsToDecimalString(proposal.unitsAfter)}.`,
  );
  return { id: record.id, proposal, forfeitureReceiptId: receiptId };
}

export async function confirmCredit(
  tx: Tx,
  i: MutationInput & {
    id: string;
    expectedPoolACents: Cents;
    expectedPoolBCents: Cents;
    expectedCreditDate?: IsoDate;
  },
) {
  const companyId = i.company.id;
  const { record, config, today, preferredClass } = await lockedDefault(
    tx,
    i.company,
    i.id,
  );
  if (record.status === "VOIDED") ruleViolation("This default was voided.");
  if (record.forfeitureConfirmedAt === null) {
    ruleViolation("Confirm the forfeiture first (Section 4.9(iv)).");
  }
  if (record.creditConfirmedAt !== null) {
    ruleViolation("The credit was already confirmed.");
  }
  if (!preferredClass.fractionalUnitsAllowed) {
    ruleViolation(
      "Credits issue fractional Preferred Units (Section 4.9(iv)); allow fractional units on the Preferred unit class first.",
    );
  }
  const ev = evaluate(record, config, today);
  const creditDate = ev.credit.creditDate;
  if (!ev.credit.available) {
    ruleViolation(
      `The Forfeited Amount is credited on the Credit Date ${creditDate} (Section 4.9(iv)).`,
    );
  }
  await assertLedgerDateOpen(tx, companyId, creditDate);
  await assertEarlierStepsConfirmed(
    tx,
    companyId,
    config,
    today,
    record,
    "CREDIT",
    toDateOnly(record.dueOn),
  );
  const { proposal, counted } = await creditProposal(
    tx,
    companyId,
    record,
    ev,
    config,
  );
  if (proposal.blocked === "NO_ELIGIBLE_HOLDERS") {
    ruleViolation(
      "No holder other than the Defaulting Member held Preferred Units on the due date, so the clause (B) credit cannot be allocated; consult counsel (Section 4.9(iv)).",
    );
  }
  if (
    proposal.poolA !== i.expectedPoolACents ||
    proposal.poolB !== i.expectedPoolBCents ||
    (i.expectedCreditDate !== undefined && i.expectedCreditDate !== creditDate)
  ) {
    conflict(
      `The credit is now pool (A) ${formatCents(proposal.poolA)} and pool (B) ${formatCents(proposal.poolB)} on ${creditDate}; review and confirm again.`,
    );
  }

  // Which commitment each credit goes on; refuse before writing anything.
  const holderIds = [...new Set(proposal.credits.map((c) => c.holderId))];
  const commitments =
    holderIds.length === 0
      ? []
      : await tx.commitment.findMany({
          where: {
            companyId,
            unitClassId: preferredClass.id,
            stakeholderId: { in: holderIds },
            status: { in: ["ACCEPTED", "REDUCED"] },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, stakeholderId: true, acceptedOn: true },
        });
  const activeCommitments = new Map<string, ActiveCommitment[]>();
  for (const c of commitments) {
    const list = activeCommitments.get(c.stakeholderId) ?? [];
    list.push({ id: c.id, acceptedOn: dateOrNull(c.acceptedOn) });
    activeCommitments.set(c.stakeholderId, list);
  }
  const { targets, missing } = planCreditTargets({
    credits: proposal.credits,
    fundings: counted,
    activeCommitments,
  });
  const names = await stakeholderNames(tx, companyId, [
    record.stakeholderId,
    ...holderIds,
  ]);
  if (missing.length > 0) {
    const first = missing[0];
    const name = (first && names.get(first.holderId)) ?? "A credited holder";
    ruleViolation(
      first?.clause === "A"
        ? `${name}'s Replacement Funder commitment is no longer active; the clause (A) credit cannot be recorded (Section 4.9(iv)).`
        : `${name} holds Preferred Units only by transfer; record a commitment for them first (Section 4.9(iv)).`,
    );
  }

  const written: {
    holderId: string;
    clause: "A" | "B";
    receiptId: string;
    note: string | null;
    amount: Cents;
    units: MicroUnits;
  }[] = [];
  for (const t of targets) {
    const receipt = await recordCapitalReceipt(
      tx,
      {
        companyId,
        commitmentId: t.commitmentId,
        receivedOn: creditDate,
        amountCents: 0n,
        sourceType: "memberDefault",
        sourceId: record.id,
        note: `Section 4.9(iv) clause (${t.clause}) credit from the default of ${names.get(record.stakeholderId) ?? "a member"}${t.note ? `; ${t.note}` : ""}`,
        special: { kind: "CREDIT", appliedCents: t.amount },
      },
      i.actor,
    );
    if (
      receipt.kind !== "CREDIT" ||
      receipt.appliedCents !== t.amount ||
      dateOrNull(receipt.appliedOn) !== creditDate ||
      microUnitsFromDecimal(unitsToWire(receipt.unitsIssued)) !== t.units
    ) {
      ledgerDisagrees(`CREDIT receipt for ${t.holderId}`);
    }
    await tx.memberDefaultCredit.create({
      data: {
        companyId,
        memberDefaultId: record.id,
        stakeholderId: t.holderId,
        commitmentId: t.commitmentId,
        clause: t.clause,
        amountCents: t.amount,
        units: receipt.unitsIssued,
        capitalReceiptId: receipt.id,
      },
    });
    written.push({
      holderId: t.holderId,
      clause: t.clause,
      receiptId: receipt.id,
      note: t.note,
      amount: t.amount,
      units: t.units,
    });
  }
  if (written.length > 0) {
    // Cross-checks the engine against FOUNDATION's getMemberPositions.
    await getPositions(tx, companyId, creditDate);
  }
  await guardedUpdate(
    () =>
      tx.memberDefault.update({
        where: {
          id: record.id,
          companyId,
          status: { not: "VOIDED" },
          creditConfirmedAt: null,
        },
        data: {
          creditDate: fromDateOnly(creditDate),
          fundedAtCreditCents: proposal.fundedCounted,
          creditPoolACents: proposal.poolA,
          creditRedirectedCents: proposal.redirected,
          creditPoolBCents: proposal.poolB,
          creditConfirmedAt: new Date(),
          creditConfirmedById: createdBy(i.actor),
        },
      }),
    "The default changed; reload and try again.",
  );
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.credit-confirmed",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
      ...written.map((w) => ({
        type: "capitalReceipt" as const,
        id: w.receiptId,
      })),
    ],
    `${i.actor.name} confirmed the Section 4.9(iv) credit of the ${formatCents(storedForfeiture(record)?.forfeited ?? 0n)} Forfeited Amount of ${names.get(record.stakeholderId) ?? "the Defaulting Member"} on the Credit Date ${creditDate}: Replacement Funder funding counted ${formatCents(proposal.fundedCounted)}; pool (A) ${formatCents(proposal.poolA)}${proposal.redirected > 0n ? ` (${formatCents(proposal.redirected)} of insider shares moved to clause (B))` : ""}; pool (B) ${formatCents(proposal.poolB)}. ${
      written.length === 0
        ? "Nothing to credit."
        : written
            .map(
              (w) =>
                `${names.get(w.holderId) ?? w.holderId} clause (${w.clause}) ${formatCents(w.amount)} = ${microUnitsToDecimalString(w.units)} units${w.note ? ` (${w.note})` : ""}`,
            )
            .join("; ")
    }.`,
  );
  return { id: record.id, creditDate, proposal };
}

export async function confirmCure(
  tx: Tx,
  i: MutationInput & { id: string; expectedCuredOn: IsoDate },
) {
  const companyId = i.company.id;
  const { record, config, today } = await lockedDefault(tx, i.company, i.id);
  if (record.status !== "OPEN")
    ruleViolation("Only an open default can be cured.");
  const ev = evaluate(record, config, today);
  if (ev.cure.blockedByForfeiture) {
    ruleViolation(
      "The default was not cured by the Forfeiture Date; confirm the forfeiture first (a later payment does not reverse a forfeiture, Section 4.9).",
    );
  }
  if (!ev.cure.cured || ev.cure.method === null || ev.cure.curedOn === null) {
    ruleViolation(
      "The default is not cured: the unpaid Balance, interest and costs must be paid, or the Balance funded in full by Replacement Funders and the Forfeited Amount credited (Section 4.9).",
    );
  }
  if (ev.cure.curedOn !== i.expectedCuredOn) {
    conflict(
      `The cure date is now ${ev.cure.curedOn}; review and confirm again.`,
    );
  }
  const curedOn = ev.cure.curedOn;
  const method = ev.cure.method;
  await guardedUpdate(
    () =>
      tx.memberDefault.update({
        where: { id: record.id, companyId, status: "OPEN" },
        data: {
          status: "CURED",
          curedOn: fromDateOnly(curedOn),
          cureMethod: method,
          curedAt: new Date(),
          curedById: createdBy(i.actor),
        },
      }),
    "The default changed; reload and try again.",
  );
  const names = await stakeholderNames(tx, companyId, [record.stakeholderId]);
  await audit(
    tx,
    i.actor,
    companyId,
    "memberDefault.cured",
    [
      { type: "memberDefault", id: record.id },
      { type: "stakeholder", id: record.stakeholderId },
    ],
    `${i.actor.name} confirmed that the default of ${names.get(record.stakeholderId) ?? "the Defaulting Member"} due ${toDateOnly(record.dueOn)} was cured on ${curedOn} (${
      method === "PAID_IN_FULL"
        ? "unpaid Balance paid with interest and costs"
        : "Balance funded in full by Replacement Funders and the Forfeited Amount credited"
    }, Section 4.9); voting suspension ends on that date.`,
  );
  return { id: record.id, curedOn, method };
}
