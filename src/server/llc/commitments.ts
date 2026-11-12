/**
 * Commitments and capital receipts ledger (F6). Every write in the LLC
 * ledger goes through these functions: the Commitments UI (through the
 * commitment router), the Exhibit B flow, the Exhibit A import and
 * ECONOMICS / GOVERNANCE server code.
 *
 * Rules:
 * - Every function takes an interactive transaction client first and runs
 *   inside the caller's transaction; each writes its own audit row there.
 * - Every lookup is scoped by `companyId`; a miss throws NOT_FOUND.
 * - Rows are never deleted or edited after the fact: receipts are corrected
 *   by voiding and re-recording.
 * - Money is bigint cents, units are 6-dp strings, dates are `YYYY-MM-DD`.
 * - Concurrency: every mutation first takes a row lock on the unit class
 *   (`lockUnitClass`, SELECT … FOR UPDATE) and only then reads the figures it
 *   validates (status, held cash, cash applied, accepted total under the
 *   cap). Under READ COMMITTED each statement after the lock sees the
 *   committed result of the transaction that held it, so two concurrent
 *   acceptances that together exceed the offering cap cannot both succeed.
 */
import type {
  AccreditationBasisEnum,
  CapitalReceipt,
  Commitment,
  Stakeholder,
  UnitClass,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  allocateHeldReceipts,
  computeSubscriptionClock,
  decisionStatus,
  defaultKeepCents,
  deriveReceiptKind,
  type OfferingTerms,
  prefReturnStartDate,
  type ReceiptKind,
  type RuleError,
  RuleViolation,
  refundDueCents,
  validateAcceptance,
  validateCashReceipt,
} from "@/lib/admission/commitment-rules";
import {
  fromDateOnly,
  isValidDateOnly,
  todayInTimeZone,
} from "@/lib/date-only";
import { addBusinessDays } from "@/lib/llc/business-days";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import { unitsForAmount } from "@/lib/llc/units";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import type { PrismaTransactionalClient } from "@/server/db";
import {
  forfeitureUnits,
  type SpecialReceiptKind,
  sumCashApplied,
  sumUnits,
  validateSpecialReceipt,
} from "@/server/llc/receipt-rules";
import { dateToWire, trimUnits, unitsToWire } from "@/server/llc/serialize";

export type LedgerActor = {
  userId: string;
  memberId: string | null;
  name: string;
  requestIp: string;
  userAgent: string;
};

type Tx = PrismaTransactionalClient;

// ---------------------------------------------------------------------------
// Helpers

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

function notFound(message: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message });
}

function throwIfErrors(errors: RuleError[]): void {
  if (errors.length > 0) {
    throw badRequest(errors.map((e) => e.message).join(" "));
  }
}

/** Runs a rule function that may throw `RuleViolation`; rethrows as BAD_REQUEST. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RuleViolation) throw badRequest(error.message);
    throw error;
  }
}

function dbDate(value: string, label: string): Date {
  if (!isValidDateOnly(value)) {
    throw badRequest(`${label} must be a date in the format YYYY-MM-DD.`);
  }
  return fromDateOnly(value);
}

function optionalDbDate(
  value: string | undefined,
  label: string,
): Date | undefined {
  return value === undefined ? undefined : dbDate(value, label);
}

function wireDate(d: Date): string {
  // Non-null DB dates only; `dateToWire` returns null only for null.
  return d.toISOString().slice(0, 10);
}

async function writeAudit(
  tx: Tx,
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

function termsOf(unitClass: UnitClass): OfferingTerms {
  return {
    minCommitmentCents: unitClass.minCommitmentCents,
    minCommitmentFloorCents: unitClass.minCommitmentFloorCents,
    offeringCapCents: unitClass.offeringCapCents,
    initialInstallmentBps: unitClass.initialInstallmentBps,
    finalClosingDate: dateToWire(unitClass.finalClosingDate),
    balanceOutsideDate: dateToWire(unitClass.balanceOutsideDate),
    acceptanceBusinessDays: unitClass.acceptanceBusinessDays,
    refundBusinessDays: unitClass.refundBusinessDays,
    prefReturnBps: unitClass.prefReturnBps,
    balanceReturnStartRule: unitClass.balanceReturnStartRule,
  };
}

function requirePrice(unitClass: UnitClass): bigint {
  const price = unitClass.pricePerUnitCents;
  if (price === null || price <= 0n) {
    throw badRequest("Set the price per unit of the unit class first.");
  }
  return price;
}

function unitsFor(cents: bigint, unitClass: UnitClass): string {
  return unitsForAmount(
    cents,
    requirePrice(unitClass),
    unitClass.fractionalUnitsAllowed,
  );
}

async function companyToday(tx: Tx, companyId: string): Promise<string> {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { timezone: true },
  });
  if (!company) throw notFound("Company not found.");
  return todayInTimeZone(company.timezone);
}

const KIND_LABEL: Record<ReceiptKind, string> = {
  INITIAL: "Initial Installment",
  BALANCE: "Balance",
  REPLACEMENT: "Replacement Funder payment",
  CREDIT: "Section 4.9(iv) credit",
  FORFEITURE: "Section 4.9(iv) forfeiture",
};

const unitsText = (units: string) => `${trimUnits(units)} units`;

// ---------------------------------------------------------------------------
// Locking and loading

/** Row lock on the unit class; serialises every ledger write of the class. */
export async function lockUnitClass(
  tx: Tx,
  companyId: string,
  unitClassId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "UnitClass"
    WHERE id = ${unitClassId} AND "companyId" = ${companyId}
    FOR UPDATE`;
  if (rows.length === 0) throw notFound("Unit class not found.");
}

async function lockAndLoadUnitClass(
  tx: Tx,
  companyId: string,
  unitClassId: string,
): Promise<UnitClass> {
  await lockUnitClass(tx, companyId, unitClassId);
  const unitClass = await tx.unitClass.findFirst({
    where: { id: unitClassId, companyId },
  });
  if (!unitClass) throw notFound("Unit class not found.");
  return unitClass;
}

type StakeholderSummary = Pick<
  Stakeholder,
  "id" | "name" | "memberStatus" | "admittedOn" | "accreditationBasis"
>;

const stakeholderSelect = {
  id: true,
  name: true,
  memberStatus: true,
  admittedOn: true,
  accreditationBasis: true,
} as const;

type LockedCommitment = Commitment & {
  stakeholder: StakeholderSummary;
  receipts: CapitalReceipt[];
};

/**
 * Finds the commitment's class (scoped), locks it, and only then loads the
 * commitment, its stakeholder and its non-void receipts.
 */
async function loadLockedCommitment(
  tx: Tx,
  companyId: string,
  commitmentId: string,
): Promise<{ commitment: LockedCommitment; unitClass: UnitClass }> {
  const ref = await tx.commitment.findFirst({
    where: { id: commitmentId, companyId },
    select: { unitClassId: true },
  });
  if (!ref) throw notFound("Commitment not found.");
  const unitClass = await lockAndLoadUnitClass(tx, companyId, ref.unitClassId);
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, companyId },
    include: {
      stakeholder: { select: stakeholderSelect },
      receipts: {
        where: { voidedAt: null },
        orderBy: [{ receivedOn: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!commitment) throw notFound("Commitment not found.");
  return { commitment, unitClass };
}

function heldReceipts(receipts: CapitalReceipt[]) {
  return receipts.map((r) => ({
    id: r.id,
    receivedOn: wireDate(r.receivedOn),
    amountCents: r.amountCents,
  }));
}

function clockFor(
  commitment: Commitment,
  unitClass: UnitClass,
  receipts: CapitalReceipt[],
) {
  return computeSubscriptionClock(
    {
      signedOn: dateToWire(commitment.signedOn),
      committedCents: commitment.committedCents,
      initialInstallmentBps: unitClass.initialInstallmentBps,
      receipts: heldReceipts(receipts),
      acceptanceBusinessDays: unitClass.acceptanceBusinessDays,
      refundBusinessDays: unitClass.refundBusinessDays,
      finalClosingDate: dateToWire(unitClass.finalClosingDate),
    },
    addBusinessDays,
  );
}

/**
 * Admission side effects of an acceptance or a Common issuance. A PROSPECT
 * is admitted through `admitStakeholder`; anyone else (already a MEMBER, or a
 * FINANCIAL_INTEREST_ONLY holder, who is never upgraded implicitly) only has
 * `admittedOn` moved earlier when needed, audited when it was empty.
 */
async function applyAdmission(
  tx: Tx,
  companyId: string,
  stakeholder: StakeholderSummary,
  admittedOn: string,
  actor: LedgerActor,
): Promise<void> {
  if (stakeholder.memberStatus === "PROSPECT") {
    await admitStakeholder(
      tx,
      { companyId, stakeholderId: stakeholder.id, admittedOn },
      actor,
    );
    return;
  }
  const current = dateToWire(stakeholder.admittedOn);
  if (current !== null && current <= admittedOn) return;
  await tx.stakeholder.update({
    where: { id: stakeholder.id, companyId },
    data: { admittedOn: fromDateOnly(admittedOn) },
  });
  if (current === null) {
    await writeAudit(
      tx,
      actor,
      companyId,
      "stakeholder.admitted",
      [{ type: "stakeholder", id: stakeholder.id }],
      `${actor.name} recorded ${admittedOn} as the admission date of ${stakeholder.name}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Commitments

export async function createCommitment(
  tx: Tx,
  input: {
    companyId: string;
    stakeholderId: string;
    unitClassId: string;
    committedCents: bigint;
    signedOn?: string;
    investmentSummaryDate?: string;
    accreditationBasis?: AccreditationBasisEnum;
    notes?: string;
    isReplacement?: boolean;
  },
  actor: LedgerActor,
): Promise<Commitment> {
  const { companyId } = input;
  const stakeholder = await tx.stakeholder.findFirst({
    where: { id: input.stakeholderId, companyId },
    select: { id: true, name: true },
  });
  if (!stakeholder) throw notFound("Member not found.");

  const unitClass = await lockAndLoadUnitClass(
    tx,
    companyId,
    input.unitClassId,
  );
  if (unitClass.kind !== "PREFERRED") {
    throw badRequest(
      "Commitments are made for Preferred Units only. Common Units are issued with Issue common units.",
    );
  }
  if (input.committedCents <= 0n) {
    throw badRequest("The committed amount must be more than zero.");
  }
  const signedOn = optionalDbDate(input.signedOn, "The signature date");
  const investmentSummaryDate = optionalDbDate(
    input.investmentSummaryDate,
    "The Investment Summary date",
  );

  const pending = await tx.commitment.findFirst({
    where: {
      companyId,
      stakeholderId: stakeholder.id,
      unitClassId: unitClass.id,
      status: "PENDING",
    },
    select: { id: true },
  });
  if (pending)
    throw badRequest("This member already has a pending commitment.");

  const created = await tx.commitment.create({
    data: {
      companyId,
      stakeholderId: stakeholder.id,
      unitClassId: unitClass.id,
      committedCents: input.committedCents,
      signedOn,
      investmentSummaryDate,
      accreditationBasis: input.accreditationBasis,
      notes: input.notes,
      isReplacement: input.isReplacement ?? false,
    },
  });
  await refreshSubscriptionClock(tx, created.id);

  await writeAudit(
    tx,
    actor,
    companyId,
    "commitment.created",
    [
      { type: "commitment", id: created.id },
      { type: "stakeholder", id: stakeholder.id },
    ],
    `${actor.name} recorded a commitment of ${formatCents(input.committedCents)} from ${stakeholder.name}${
      input.signedOn ? `, signed ${input.signedOn}` : ""
    }${input.isReplacement ? " (Replacement Funder)" : ""}.`,
  );

  return tx.commitment.findFirstOrThrow({
    where: { id: created.id, companyId },
  });
}

export async function updatePendingCommitment(
  tx: Tx,
  input: {
    companyId: string;
    commitmentId: string;
    committedCents?: bigint;
    signedOn?: string;
    investmentSummaryDate?: string;
    accreditationBasis?: AccreditationBasisEnum;
    notes?: string;
  },
  actor: LedgerActor,
): Promise<Commitment> {
  const { companyId } = input;
  const { commitment } = await loadLockedCommitment(
    tx,
    companyId,
    input.commitmentId,
  );
  if (commitment.status !== "PENDING") {
    throw badRequest("Only a pending commitment can be changed.");
  }
  if (input.committedCents !== undefined && input.committedCents <= 0n) {
    throw badRequest("The committed amount must be more than zero.");
  }
  const signedOn = optionalDbDate(input.signedOn, "The signature date");
  const investmentSummaryDate = optionalDbDate(
    input.investmentSummaryDate,
    "The Investment Summary date",
  );

  const changes: string[] = [];
  if (
    input.committedCents !== undefined &&
    input.committedCents !== commitment.committedCents
  ) {
    changes.push(
      `amount ${formatCents(commitment.committedCents)} → ${formatCents(input.committedCents)}`,
    );
  }
  const dateChange = (label: string, before: Date | null, after?: string) => {
    if (after !== undefined && after !== dateToWire(before)) {
      changes.push(`${label} ${dateToWire(before) ?? "none"} → ${after}`);
    }
  };
  dateChange("signature date", commitment.signedOn, input.signedOn);
  dateChange(
    "Investment Summary date",
    commitment.investmentSummaryDate,
    input.investmentSummaryDate,
  );
  if (
    input.accreditationBasis !== undefined &&
    input.accreditationBasis !== commitment.accreditationBasis
  ) {
    changes.push(
      `accreditation ${commitment.accreditationBasis ?? "none"} → ${input.accreditationBasis}`,
    );
  }
  if (input.notes !== undefined && input.notes !== commitment.notes) {
    changes.push("notes");
  }

  await tx.commitment.update({
    where: { id: commitment.id, companyId },
    data: {
      committedCents: input.committedCents,
      signedOn,
      investmentSummaryDate,
      accreditationBasis: input.accreditationBasis,
      notes: input.notes,
    },
  });
  await refreshSubscriptionClock(tx, commitment.id);

  await writeAudit(
    tx,
    actor,
    companyId,
    "commitment.updated",
    [
      { type: "commitment", id: commitment.id },
      { type: "stakeholder", id: commitment.stakeholderId },
    ],
    `${actor.name} updated the pending commitment from ${commitment.stakeholder.name}: ${
      changes.length > 0 ? changes.join("; ") : "no changes"
    }.`,
  );

  return tx.commitment.findFirstOrThrow({
    where: { id: commitment.id, companyId },
  });
}

/**
 * Recomputes the Section 4.8 decision deadline of a PENDING commitment from
 * its non-void receipts (stores `acceptanceDeadline` only). Called by the
 * services after they have scoped the commitment to the company.
 */
export async function refreshSubscriptionClock(
  tx: Tx,
  commitmentId: string,
): Promise<void> {
  const commitment = await tx.commitment.findUnique({
    where: { id: commitmentId },
    include: {
      unitClass: true,
      receipts: { where: { voidedAt: null } },
    },
  });
  if (commitment?.status !== "PENDING") return;
  const clock = clockFor(commitment, commitment.unitClass, commitment.receipts);
  await tx.commitment.update({
    where: { id: commitment.id },
    data: {
      acceptanceDeadline:
        clock.acceptanceDeadline === null
          ? null
          : fromDateOnly(clock.acceptanceDeadline),
    },
  });
}

export async function decideCommitment(
  tx: Tx,
  input: {
    companyId: string;
    commitmentId: string;
    decision: "ACCEPT" | "REJECT";
    acceptedCents?: bigint;
    keepCents?: bigint;
    acceptedOn: string;
    minimumWaived?: boolean;
    minimumWaiverNote?: string;
    rejectionReason?: string;
    skipClosingDateCheck?: boolean;
  },
  actor: LedgerActor,
): Promise<Commitment> {
  const { companyId } = input;
  const { commitment, unitClass } = await loadLockedCommitment(
    tx,
    companyId,
    input.commitmentId,
  );
  if (commitment.status !== "PENDING") {
    throw badRequest("This commitment has already been decided.");
  }
  const acceptedOnDate = dbDate(input.acceptedOn, "The decision date");
  const acceptedOn = input.acceptedOn;
  const today = await companyToday(tx, companyId);
  const receipts = commitment.receipts;
  const held = receipts.reduce((sum, r) => sum + r.amountCents, 0n);
  const clock = clockFor(commitment, unitClass, receipts);
  const refundDueByFor = (refund: bigint): Date | null =>
    refund > 0n
      ? fromDateOnly(
          clock.refundDueBy ??
            addBusinessDays(acceptedOn, unitClass.refundBusinessDays),
        )
      : null;
  const stakeholder = commitment.stakeholder;

  if (input.decision === "REJECT") {
    const reason = input.rejectionReason?.trim() ?? "";
    if (reason.length < 3) {
      throw badRequest(
        "Give a reason for the rejection (at least 3 characters).",
      );
    }
    if (acceptedOn > today) {
      throw badRequest("The decision date cannot be in the future.");
    }
    const refundDueBy = refundDueByFor(held);
    await tx.commitment.update({
      where: { id: commitment.id, companyId },
      data: {
        status: "REJECTED",
        acceptedCents: 0n,
        acceptedOn: acceptedOnDate,
        decidedAt: new Date(),
        decidedByMemberId: actor.memberId,
        rejectionReason: reason,
        refundDueCents: held,
        refundDueBy,
      },
    });
    const cancelled = await tx.template.updateMany({
      where: { companyId, commitmentId: commitment.id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    await writeAudit(
      tx,
      actor,
      companyId,
      "commitment.rejected",
      [
        { type: "commitment", id: commitment.id },
        { type: "stakeholder", id: stakeholder.id },
      ],
      `${actor.name} rejected the ${formatCents(commitment.committedCents)} commitment from ${stakeholder.name} on ${acceptedOn}: ${reason}${
        held > 0n
          ? `; ${formatCents(held)} received must be returned by ${dateToWire(refundDueBy)}`
          : ""
      }${cancelled.count > 0 ? "; the Exhibit B packet was cancelled" : ""}.`,
    );
    return tx.commitment.findFirstOrThrow({
      where: { id: commitment.id, companyId },
    });
  }

  // ACCEPT (in full or reduced)
  const terms = termsOf(unitClass);
  const accepted = input.acceptedCents ?? commitment.committedCents;
  const keep =
    input.keepCents ??
    defaultKeepCents({
      heldCents: held,
      acceptedCents: accepted,
      committedCents: commitment.committedCents,
    });
  const others = await tx.commitment.aggregate({
    where: {
      companyId,
      unitClassId: unitClass.id,
      status: { in: ["ACCEPTED", "REDUCED"] },
      id: { not: commitment.id },
    },
    _sum: { acceptedCents: true },
  });
  throwIfErrors(
    validateAcceptance({
      terms,
      committedCents: commitment.committedCents,
      acceptedCents: accepted,
      acceptedOn,
      signedOn: dateToWire(commitment.signedOn),
      today,
      heldCents: held,
      keepCents: keep,
      otherAcceptedCents: others._sum.acceptedCents ?? 0n,
      minimumWaived: input.minimumWaived ?? false,
      isReplacement: commitment.isReplacement,
      skipClosingDateCheck: input.skipClosingDateCheck ?? false,
    }),
  );
  const status = rule(() =>
    decisionStatus(accepted, commitment.committedCents),
  );

  const allocations = allocateHeldReceipts(heldReceipts(receipts), keep);
  const issued: string[] = [];
  for (const allocation of allocations) {
    const receipt = receipts.find((r) => r.id === allocation.id);
    if (!receipt) continue;
    const applied = allocation.appliedCents;
    const units = applied > 0n ? unitsFor(applied, unitClass) : "0.000000";
    issued.push(units);
    await tx.capitalReceipt.update({
      where: { id: receipt.id, companyId },
      data: {
        kind: "INITIAL",
        appliedCents: applied,
        unitsIssued: units,
        appliedOn: applied > 0n ? acceptedOnDate : null,
        prefReturnStartDate:
          applied > 0n && unitClass.prefReturnBps > 0
            ? receipt.receivedOn
            : null,
      },
    });
  }

  const refund = refundDueCents(held, keep);
  const minimumWaived =
    unitClass.minCommitmentCents !== null &&
    accepted < unitClass.minCommitmentCents;
  await tx.commitment.update({
    where: { id: commitment.id, companyId },
    data: {
      status,
      acceptedCents: accepted,
      acceptedOn: acceptedOnDate,
      decidedAt: new Date(),
      decidedByMemberId: actor.memberId,
      minimumWaived,
      minimumWaiverNote: minimumWaived
        ? (input.minimumWaiverNote?.trim() ?? null)
        : null,
      refundDueCents: refund,
      refundDueBy: refundDueByFor(refund),
    },
  });

  await tx.stakeholder.update({
    where: { id: stakeholder.id, companyId },
    data: {
      currentRelationship: "INVESTOR",
      ...(stakeholder.accreditationBasis === null &&
      commitment.accreditationBasis !== null
        ? { accreditationBasis: commitment.accreditationBasis }
        : {}),
    },
  });
  await applyAdmission(tx, companyId, stakeholder, acceptedOn, actor);

  const totalUnits = sumUnits(issued);
  const verb = status === "ACCEPTED" ? "accepted" : "accepted (reduced)";
  await writeAudit(
    tx,
    actor,
    companyId,
    status === "ACCEPTED" ? "commitment.accepted" : "commitment.reduced",
    [
      { type: "commitment", id: commitment.id },
      { type: "stakeholder", id: stakeholder.id },
      ...receipts.map((r) => ({ type: "capitalReceipt" as const, id: r.id })),
    ],
    `${actor.name} ${verb} ${formatCents(accepted)} of ${formatCents(commitment.committedCents)} from ${stakeholder.name} on ${acceptedOn}; ${formatCents(keep)} applied, ${unitsText(totalUnits)} issued${
      refund > 0n
        ? `; ${formatCents(refund)} to be refunded by ${dateToWire(refundDueByFor(refund))}`
        : ""
    }${minimumWaived ? "; minimum waived (Section 3.7)" : ""}.`,
  );

  return tx.commitment.findFirstOrThrow({
    where: { id: commitment.id, companyId },
  });
}

/**
 * Section 4.9(ii): reduces an accepted commitment by part of its unpaid
 * Balance (Replacement Funders). Status is unchanged.
 */
export async function reduceAcceptedCommitment(
  tx: Tx,
  input: {
    companyId: string;
    commitmentId: string;
    reduceByCents: bigint;
    reason: string;
  },
  actor: LedgerActor,
): Promise<Commitment> {
  const { companyId } = input;
  const { commitment } = await loadLockedCommitment(
    tx,
    companyId,
    input.commitmentId,
  );
  if (commitment.status !== "ACCEPTED" && commitment.status !== "REDUCED") {
    throw badRequest("Only an accepted commitment can be reduced.");
  }
  const reason = input.reason.trim();
  if (reason.length === 0) throw badRequest("Give a reason for the reduction.");
  const unpaid = commitment.acceptedCents - sumCashApplied(commitment.receipts);
  if (input.reduceByCents <= 0n || input.reduceByCents > unpaid) {
    throw badRequest(
      `The reduction must be more than zero and not more than the unpaid Balance of ${formatCents(unpaid > 0n ? unpaid : 0n)} (Section 4.9(ii)).`,
    );
  }
  const after = commitment.acceptedCents - input.reduceByCents;
  await tx.commitment.update({
    where: { id: commitment.id, companyId },
    data: { acceptedCents: after },
  });
  await writeAudit(
    tx,
    actor,
    companyId,
    "commitment.reduced",
    [
      { type: "commitment", id: commitment.id },
      { type: "stakeholder", id: commitment.stakeholderId },
    ],
    `${actor.name} reduced the accepted commitment of ${commitment.stakeholder.name} by ${formatCents(input.reduceByCents)}, from ${formatCents(commitment.acceptedCents)} to ${formatCents(after)}: ${reason}.`,
  );
  return tx.commitment.findFirstOrThrow({
    where: { id: commitment.id, companyId },
  });
}

export async function recordRefund(
  tx: Tx,
  input: {
    companyId: string;
    commitmentId: string;
    paidCents: bigint;
    paidOn: string;
  },
  actor: LedgerActor,
): Promise<Commitment> {
  const { companyId } = input;
  const { commitment } = await loadLockedCommitment(
    tx,
    companyId,
    input.commitmentId,
  );
  const paidOn = dbDate(input.paidOn, "The refund date");
  const outstanding = commitment.refundDueCents - commitment.refundPaidCents;
  if (input.paidCents <= 0n || input.paidCents > outstanding) {
    throw badRequest(
      `The refund must be more than zero and not more than the ${formatCents(outstanding > 0n ? outstanding : 0n)} outstanding.`,
    );
  }
  await tx.commitment.update({
    where: { id: commitment.id, companyId },
    data: {
      refundPaidCents: { increment: input.paidCents },
      refundPaidOn: paidOn,
    },
  });
  await writeAudit(
    tx,
    actor,
    companyId,
    "commitment.refund-recorded",
    [
      { type: "commitment", id: commitment.id },
      { type: "stakeholder", id: commitment.stakeholderId },
    ],
    `${actor.name} recorded a refund of ${formatCents(input.paidCents)} to ${commitment.stakeholder.name} on ${input.paidOn}; ${formatCents(outstanding - input.paidCents)} still to be refunded.`,
  );
  return tx.commitment.findFirstOrThrow({
    where: { id: commitment.id, companyId },
  });
}

// ---------------------------------------------------------------------------
// Receipts

export type RecordCapitalReceiptInput = {
  companyId: string;
  commitmentId: string;
  receivedOn: string;
  amountCents: bigint;
  reference?: string;
  note?: string;
  dueDate?: string | null;
  sourceType?: string;
  sourceId?: string;
  special?: { kind: SpecialReceiptKind; appliedCents: bigint };
};

export async function recordCapitalReceipt(
  tx: Tx,
  input: RecordCapitalReceiptInput,
  actor: LedgerActor,
): Promise<CapitalReceipt> {
  const { companyId } = input;
  const { commitment, unitClass } = await loadLockedCommitment(
    tx,
    companyId,
    input.commitmentId,
  );
  const receivedOnDate = dbDate(input.receivedOn, "The date received");
  const receivedOn = input.receivedOn;
  const dueDate = input.dueDate ?? null;
  if (dueDate !== null) dbDate(dueDate, "The due date");
  const today = await companyToday(tx, companyId);
  const terms = termsOf(unitClass);
  const cashApplied = sumCashApplied(commitment.receipts);
  const stakeholder = commitment.stakeholder;

  let kind: ReceiptKind;
  let appliedCents: bigint;
  let unitsIssued: string;
  let appliedOn: Date | null;
  let startDate: string | null;
  let summary: string;

  if (!input.special) {
    throwIfErrors(
      validateCashReceipt({
        status: commitment.status,
        acceptedCents: commitment.acceptedCents,
        cashAppliedCents: cashApplied,
        amountCents: input.amountCents,
        receivedOn,
        today,
      }),
    );
    kind = rule(() =>
      deriveReceiptKind({
        status: commitment.status,
        acceptedOn: dateToWire(commitment.acceptedOn),
        receivedOn,
      }),
    );
    if (commitment.status === "PENDING") {
      appliedCents = 0n;
      unitsIssued = "0.000000";
      appliedOn = null;
      startDate = null;
      summary = `${actor.name} recorded ${formatCents(input.amountCents)} received from ${stakeholder.name} on ${receivedOn} (${KIND_LABEL[kind]}); held until the commitment is decided`;
    } else {
      // ECONOMICS E9 adds its ledger-date guard here (decided commitments).
      appliedCents = input.amountCents;
      unitsIssued = unitsFor(appliedCents, unitClass);
      appliedOn = receivedOnDate;
      const start = prefReturnStartDate({ kind, receivedOn, dueDate, terms });
      if (start === undefined) {
        throw badRequest(
          "Set the Balance outside date of the unit class first.",
        );
      }
      startDate = start;
      summary = `${actor.name} recorded ${formatCents(input.amountCents)} received from ${stakeholder.name} on ${receivedOn} (${KIND_LABEL[kind]}); ${unitsText(unitsIssued)}; ${
        startDate ? `return starts ${startDate}` : "no Preferred Return"
      }`;
    }
  } else {
    const special = input.special;
    kind = special.kind;
    let memberCapitalCents = 0n;
    if (special.kind === "FORFEITURE") {
      const capital = await tx.capitalReceipt.aggregate({
        where: {
          companyId,
          stakeholderId: commitment.stakeholderId,
          unitClassId: unitClass.id,
          voidedAt: null,
        },
        _sum: { appliedCents: true },
      });
      memberCapitalCents = capital._sum.appliedCents ?? 0n;
    }
    throwIfErrors(
      validateSpecialReceipt({
        kind: special.kind,
        status: commitment.status,
        isReplacement: commitment.isReplacement,
        amountCents: input.amountCents,
        appliedCents: special.appliedCents,
        acceptedCents: commitment.acceptedCents,
        cashAppliedCents: cashApplied,
        receivedOn,
        today,
        memberCapitalCents,
      }),
    );
    appliedCents = special.appliedCents;
    unitsIssued =
      special.kind === "FORFEITURE"
        ? forfeitureUnits(
            appliedCents,
            requirePrice(unitClass),
            unitClass.fractionalUnitsAllowed,
          )
        : unitsFor(appliedCents, unitClass);
    appliedOn = receivedOnDate;
    startDate =
      prefReturnStartDate({ kind, receivedOn, dueDate, terms }) ?? null;
    summary =
      special.kind === "REPLACEMENT"
        ? `${actor.name} recorded ${formatCents(input.amountCents)} received from ${stakeholder.name} on ${receivedOn} (${KIND_LABEL[kind]}); ${unitsText(unitsIssued)}; ${
            startDate ? `return starts ${startDate}` : "no Preferred Return"
          }`
        : `${actor.name} recorded a ${KIND_LABEL[kind]} of ${formatCents(appliedCents)} for ${stakeholder.name} on ${receivedOn}; ${unitsText(unitsIssued)}${
            startDate ? `; return starts ${startDate}` : ""
          }`;
  }

  const receipt = await tx.capitalReceipt.create({
    data: {
      companyId,
      commitmentId: commitment.id,
      stakeholderId: commitment.stakeholderId,
      unitClassId: commitment.unitClassId,
      kind,
      receivedOn: receivedOnDate,
      amountCents: input.amountCents,
      appliedCents,
      unitsIssued,
      appliedOn,
      prefReturnStartDate: startDate === null ? null : fromDateOnly(startDate),
      reference: input.reference,
      note: input.note,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      recordedByMemberId: actor.memberId,
    },
  });
  if (commitment.status === "PENDING") {
    await refreshSubscriptionClock(tx, commitment.id);
  }

  await writeAudit(
    tx,
    actor,
    companyId,
    "capitalReceipt.recorded",
    [
      { type: "capitalReceipt", id: receipt.id },
      { type: "commitment", id: commitment.id },
      { type: "stakeholder", id: commitment.stakeholderId },
    ],
    `${summary}.`,
  );
  return receipt;
}

async function loadLockedReceipt(tx: Tx, companyId: string, receiptId: string) {
  const ref = await tx.capitalReceipt.findFirst({
    where: { id: receiptId, companyId },
    select: { unitClassId: true },
  });
  if (!ref) throw notFound("Receipt not found.");
  await lockUnitClass(tx, companyId, ref.unitClassId);
  const receipt = await tx.capitalReceipt.findFirst({
    where: { id: receiptId, companyId },
    include: {
      stakeholder: { select: { id: true, name: true } },
      commitment: { select: { id: true, status: true } },
    },
  });
  if (!receipt) throw notFound("Receipt not found.");
  return receipt;
}

export async function voidCapitalReceipt(
  tx: Tx,
  input: { companyId: string; receiptId: string; reason: string },
  actor: LedgerActor,
): Promise<CapitalReceipt> {
  const { companyId } = input;
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw badRequest(
      "Give a reason for voiding the receipt (at least 5 characters).",
    );
  }
  const receipt = await loadLockedReceipt(tx, companyId, input.receiptId);
  if (receipt.voidedAt !== null) {
    throw badRequest("This receipt has already been voided.");
  }
  // ECONOMICS E9 adds its beforeVoidReceipt guard here.
  const voided = await tx.capitalReceipt.update({
    where: { id: receipt.id, companyId },
    data: {
      voidedAt: new Date(),
      voidedByMemberId: actor.memberId,
      voidReason: reason,
    },
  });
  if (receipt.commitment.status === "PENDING") {
    await refreshSubscriptionClock(tx, receipt.commitmentId);
  }
  const units = unitsToWire(receipt.unitsIssued);
  await writeAudit(
    tx,
    actor,
    companyId,
    "capitalReceipt.voided",
    [
      { type: "capitalReceipt", id: receipt.id },
      { type: "commitment", id: receipt.commitmentId },
      { type: "stakeholder", id: receipt.stakeholderId },
    ],
    `${actor.name} voided the ${KIND_LABEL[receipt.kind]} receipt of ${formatCents(receipt.amountCents)} from ${receipt.stakeholder.name} dated ${wireDate(receipt.receivedOn)} (${formatCents(receipt.appliedCents)} applied, ${unitsText(units)}): ${reason}.`,
  );
  return voided;
}

/** Moves the Preferred Return start of an applied Balance receipt (B17). */
export async function setReceiptPrefReturnStart(
  tx: Tx,
  input: { companyId: string; receiptId: string; startDate: string },
  actor: LedgerActor,
): Promise<CapitalReceipt> {
  const { companyId } = input;
  const startDate = dbDate(input.startDate, "The start date");
  const receipt = await loadLockedReceipt(tx, companyId, input.receiptId);
  if (receipt.voidedAt !== null) {
    throw badRequest("This receipt has been voided.");
  }
  if (receipt.kind !== "BALANCE" || receipt.appliedCents <= 0n) {
    throw badRequest(
      "Only an applied Balance receipt can have its Preferred Return start moved.",
    );
  }
  const receivedOn = wireDate(receipt.receivedOn);
  if (input.startDate < receivedOn) {
    throw badRequest(
      `The Preferred Return cannot start before the money was received (${receivedOn}) (Section 5.6(b)).`,
    );
  }
  const before = dateToWire(receipt.prefReturnStartDate);
  const updated = await tx.capitalReceipt.update({
    where: { id: receipt.id, companyId },
    data: { prefReturnStartDate: startDate },
  });
  await writeAudit(
    tx,
    actor,
    companyId,
    "capitalReceipt.start-date-changed",
    [
      { type: "capitalReceipt", id: receipt.id },
      { type: "stakeholder", id: receipt.stakeholderId },
    ],
    `${actor.name} moved the Preferred Return start of the ${formatCents(receipt.appliedCents)} Balance receipt from ${receipt.stakeholder.name} (received ${receivedOn}) from ${before ?? "none"} to ${input.startDate}.`,
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Common Units and admission

const UNITS_RE = /^\d+(\.\d{1,6})?$/;

export async function issueCommonUnits(
  tx: Tx,
  input: {
    companyId: string;
    stakeholderId: string;
    units: string;
    issuedOn: string;
  },
  actor: LedgerActor,
): Promise<CapitalReceipt> {
  const { companyId } = input;
  const stakeholder = await tx.stakeholder.findFirst({
    where: { id: input.stakeholderId, companyId },
    select: stakeholderSelect,
  });
  if (!stakeholder) throw notFound("Member not found.");
  const ref = await tx.unitClass.findFirst({
    where: { companyId, kind: "COMMON" },
    select: { id: true },
  });
  if (!ref) throw notFound("The company has no Common unit class.");
  const unitClass = await lockAndLoadUnitClass(tx, companyId, ref.id);
  const issuedOnDate = dbDate(input.issuedOn, "The issue date");

  if (!UNITS_RE.test(input.units)) {
    throw badRequest("Enter the number of units with at most 6 decimals.");
  }
  const micro = microUnitsFromDecimal(input.units);
  if (micro <= 0n)
    throw badRequest("The number of units must be more than zero.");
  if (!unitClass.fractionalUnitsAllowed && micro % 1_000_000n !== 0n) {
    throw badRequest("Common Units must be issued in whole units.");
  }
  if (unitClass.authorizedUnits === null) {
    throw badRequest(
      "Set the authorized Common Units of the unit class first.",
    );
  }
  const authorized = microUnitsFromDecimal(
    unitClass.authorizedUnits.toFixed(6),
  );
  const issuedSum = await tx.capitalReceipt.aggregate({
    where: { companyId, unitClassId: unitClass.id, voidedAt: null },
    _sum: { unitsIssued: true },
  });
  const issued = microUnitsFromDecimal(unitsToWire(issuedSum._sum.unitsIssued));
  if (issued + micro > authorized) {
    const remaining = authorized - issued;
    throw badRequest(
      `Only ${trimUnits(microUnitsToDecimalString(remaining > 0n ? remaining : 0n))} Common Units remain authorized. Additional Common Units require a Preferred Supermajority (Section 3.2).`,
    );
  }
  const units = microUnitsToDecimalString(micro);

  const commitment = await tx.commitment.create({
    data: {
      companyId,
      stakeholderId: stakeholder.id,
      unitClassId: unitClass.id,
      status: "ACCEPTED",
      committedCents: 0n,
      acceptedCents: 0n,
      acceptedOn: issuedOnDate,
      decidedAt: new Date(),
      decidedByMemberId: actor.memberId,
    },
  });
  const receipt = await tx.capitalReceipt.create({
    data: {
      companyId,
      commitmentId: commitment.id,
      stakeholderId: stakeholder.id,
      unitClassId: unitClass.id,
      kind: "INITIAL",
      receivedOn: issuedOnDate,
      amountCents: 0n,
      appliedCents: 0n,
      unitsIssued: units,
      appliedOn: issuedOnDate,
      recordedByMemberId: actor.memberId,
    },
  });
  await applyAdmission(tx, companyId, stakeholder, input.issuedOn, actor);

  await writeAudit(
    tx,
    actor,
    companyId,
    "capitalReceipt.recorded",
    [
      { type: "capitalReceipt", id: receipt.id },
      { type: "commitment", id: commitment.id },
      { type: "stakeholder", id: stakeholder.id },
    ],
    `${actor.name} issued ${trimUnits(units)} Common Units to ${stakeholder.name} on ${input.issuedOn} for $0.00.`,
  );
  return receipt;
}

/**
 * Admits a stakeholder as a Member: `memberStatus = MEMBER` and `admittedOn`
 * (an earlier stored date is kept). Used for PROSPECTs by `decideCommitment`
 * and `issueCommonUnits`, and by GOVERNANCE for Substitute Members.
 */
export async function admitStakeholder(
  tx: Tx,
  input: { companyId: string; stakeholderId: string; admittedOn: string },
  actor: LedgerActor,
): Promise<Stakeholder> {
  const { companyId } = input;
  dbDate(input.admittedOn, "The admission date");
  const stakeholder = await tx.stakeholder.findFirst({
    where: { id: input.stakeholderId, companyId },
    select: stakeholderSelect,
  });
  if (!stakeholder) throw notFound("Member not found.");
  const current = dateToWire(stakeholder.admittedOn);
  const admittedOn =
    current !== null && current < input.admittedOn ? current : input.admittedOn;
  const updated = await tx.stakeholder.update({
    where: { id: stakeholder.id, companyId },
    data: { memberStatus: "MEMBER", admittedOn: fromDateOnly(admittedOn) },
  });
  await writeAudit(
    tx,
    actor,
    companyId,
    "stakeholder.admitted",
    [{ type: "stakeholder", id: stakeholder.id }],
    `${actor.name} admitted ${stakeholder.name} as a Member effective ${admittedOn}${
      admittedOn !== input.admittedOn
        ? ` (earlier admission date kept; ${input.admittedOn} entered)`
        : ""
    }.`,
  );
  return updated;
}
