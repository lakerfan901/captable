// Call Notice and default math (R26–R37).

import { allocateProRata } from "./allocate";
import { addBusinessDays, nextBusinessDay } from "./business-days";
import type { LlcEconomicsConfig } from "./config";
import {
  addDays,
  compareIso,
  daysBetween,
  type IsoDate,
  maxIso,
  minIso,
} from "./dates";
import { type Cents, LlcMathError, type MicroUnits, roundDiv } from "./money";
import type { HolderPosition } from "./positions";
import { microUnitsForAmount } from "./units";

type Cfg = LlcEconomicsConfig;

function minBig(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}
function maxBig(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

/** R26: minIso(addBusinessDays(sentOn, n), balanceOutsideDate); throws when sent after the outside date. */
export function callNoticeDueDate(
  sentOn: IsoDate,
  cfg: Pick<
    Cfg,
    "callNoticeBusinessDays" | "balanceOutsideDate" | "businessDays"
  >,
): IsoDate {
  const due = addBusinessDays(
    sentOn,
    cfg.callNoticeBusinessDays,
    cfg.businessDays,
  );
  if (cfg.balanceOutsideDate === null) return due;
  if (compareIso(sentOn, cfg.balanceOutsideDate) > 0) {
    throw new LlcMathError(
      "AFTER_OUTSIDE_DATE",
      `No Call Notice can be sent after the Balance outside date ${cfg.balanceOutsideDate} (OA 4.9)`,
    );
  }
  return minIso(due, cfg.balanceOutsideDate);
}

/** R26: max(0, accepted − initialPaid − calledTotal). */
export function uncalledBalance(i: {
  acceptedCommitment: Cents;
  initialPaid: Cents;
  calledTotal: Cents;
}): Cents {
  return maxBig(0n, i.acceptedCommitment - i.initialPaid - i.calledTotal);
}

export interface OpenLine {
  lineId: string;
  dueOn: IsoDate | null;
  outstanding: Cents;
  createdSeq: number;
}

/** R28/R29: oldest dueOn first (then createdSeq); lines without a dueOn are skipped; the rest is unallocated. */
export function allocatePaymentToLines(
  amount: Cents,
  receivedOn: IsoDate,
  lines: readonly OpenLine[],
  rule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE",
): {
  allocations: { lineId: string; amount: Cents; prefReturnStartOn: IsoDate }[];
  unallocated: Cents;
} {
  if (amount < 0n) {
    throw new LlcMathError("NEGATIVE", "Payment amount must not be negative");
  }
  const ordered = lines
    .filter(
      (l): l is OpenLine & { dueOn: IsoDate } =>
        l.dueOn !== null && l.outstanding > 0n,
    )
    .sort(
      (a, b) => compareIso(a.dueOn, b.dueOn) || a.createdSeq - b.createdSeq,
    );
  let remaining = amount;
  const allocations: {
    lineId: string;
    amount: Cents;
    prefReturnStartOn: IsoDate;
  }[] = [];
  for (const line of ordered) {
    if (remaining === 0n) break;
    const take = minBig(remaining, line.outstanding);
    remaining -= take;
    allocations.push({
      lineId: line.lineId,
      amount: take,
      prefReturnStartOn:
        rule === "RECEIPT_DATE" ? receivedOn : maxIso(receivedOn, line.dueOn),
    });
  }
  return { allocations, unallocated: remaining };
}

/** R33: addBusinessDays(dueOn, 5). */
export function forfeitureDate(
  dueOn: IsoDate,
  cfg: Pick<Cfg, "forfeitureCureBusinessDays" | "businessDays">,
): IsoDate {
  return addBusinessDays(
    dueOn,
    cfg.forfeitureCureBusinessDays,
    cfg.businessDays,
  );
}

/** R31: nextBusinessDay(dueOn) .. replacementFunderOutsideDate. */
export function replacementWindow(
  dueOn: IsoDate,
  cfg: Pick<Cfg, "replacementFunderOutsideDate" | "businessDays">,
): { opensOn: IsoDate; closesOn: IsoDate } {
  return {
    opensOn: nextBusinessDay(dueOn, cfg.businessDays),
    closesOn: cfg.replacementFunderOutsideDate,
  };
}

/** R35: max(forfeitureDate, min(dueOn + 30 days, fullyFundedOn ?? +∞)). */
export function creditDate(
  i: { dueOn: IsoDate; forfeitureDate: IsoDate; fullyFundedOn: IsoDate | null },
  cfg: Pick<Cfg, "creditDateMaxDays">,
): IsoDate {
  const outer = addDays(i.dueOn, cfg.creditDateMaxDays);
  const earlier =
    i.fullyFundedOn === null ? outer : minIso(outer, i.fullyFundedOn);
  return maxIso(i.forfeitureDate, earlier);
}

export interface BalanceReduction {
  on: IsoDate;
  amount: Cents;
  by: "MEMBER" | "REPLACEMENT_FUNDER";
}

const REDUCTION_KIND_ORDER: Record<BalanceReduction["by"], number> = {
  MEMBER: 0,
  REPLACEMENT_FUNDER: 1,
};

/**
 * The one ordering of reductions every consumer uses: by date; on the same
 * date MEMBER before REPLACEMENT_FUNDER; then input index. Results never
 * depend on the input order.
 */
function sortedReductions(
  reductions: readonly BalanceReduction[],
): BalanceReduction[] {
  for (const r of reductions) {
    if (r.amount < 0n) {
      throw new LlcMathError(
        "NEGATIVE",
        "Reduction amount must not be negative",
      );
    }
  }
  return reductions
    .map((r, index) => ({ r, index }))
    .sort(
      (a, b) =>
        compareIso(a.r.on, b.r.on) ||
        REDUCTION_KIND_ORDER[a.r.by] - REDUCTION_KIND_ORDER[b.r.by] ||
        a.index - b.index,
    )
    .map(({ r }) => r);
}

/** Unpaid Balance after the reductions dated on or before asOf (never negative). */
export function outstandingBalance(
  unpaidAtDue: Cents,
  reductions: readonly BalanceReduction[],
  asOf: IsoDate,
): Cents {
  let bal = unpaidAtDue;
  for (const r of sortedReductions(reductions)) {
    if (compareIso(r.on, asOf) > 0) break;
    bal -= r.amount;
  }
  return maxBig(0n, bal);
}

/** First date the running balance reaches 0, if the reduction that reached 0 was by a Replacement Funder; else null (same-day order: MEMBER first). */
export function fullyFundedOn(
  unpaidAtDue: Cents,
  reductions: readonly BalanceReduction[],
): IsoDate | null {
  if (unpaidAtDue <= 0n) return null;
  let bal = unpaidAtDue;
  for (const r of sortedReductions(reductions)) {
    if (r.amount === 0n) continue;
    bal -= r.amount;
    if (bal <= 0n) return r.by === "REPLACEMENT_FUNDER" ? r.on : null;
  }
  return null;
}

/** R30: simple interest on the outstanding amount, piecewise between reduction dates, rounded once. */
export function defaultInterest(
  i: {
    unpaidAtDue: Cents;
    dueOn: IsoDate;
    reductions: readonly BalanceReduction[];
    asOf: IsoDate;
  },
  cfg: Pick<Cfg, "defaultInterestBps" | "defaultInterestDayBasis">,
): Cents {
  if (compareIso(i.asOf, i.dueOn) <= 0) return 0n;
  let bal = i.unpaidAtDue;
  let from = i.dueOn;
  let numerator = 0n;
  for (const r of sortedReductions(i.reductions)) {
    if (compareIso(r.on, i.asOf) > 0) break;
    const at = maxIso(r.on, i.dueOn);
    const days = daysBetween(from, at);
    if (days > 0 && bal > 0n) numerator += bal * BigInt(days);
    from = at;
    bal = maxBig(0n, bal - r.amount);
  }
  const days = daysBetween(from, i.asOf);
  if (days > 0 && bal > 0n) numerator += bal * BigInt(days);
  return roundDiv(
    numerator * BigInt(cfg.defaultInterestBps),
    BigInt(cfg.defaultInterestDayBasis) * 10_000n,
  );
}

export interface ForfeitureProposal {
  unpaidAtForfeiture: Cents;
  halfOfUnpaid: Cents;
  capitalPaid: Cents;
  capBinding: boolean;
  forfeited: Cents;
  unreturnedDeducted: Cents;
  extinguishedReturn: Cents;
  contributedAfter: Cents;
  unitsBefore: MicroUnits;
  unitsAfter: MicroUnits;
}

/** R33/R34. `position` is the member's position as of the Forfeiture Date before the forfeiture event. */
export function computeForfeiture(
  i: {
    unpaidAtDue: Cents;
    reductions: readonly BalanceReduction[];
    forfeitureDate: IsoDate;
    position: Pick<
      HolderPosition,
      "contributed" | "unreturned" | "unpaidReturn" | "preferredUnits"
    >;
  },
  cfg: Pick<
    Cfg,
    | "forfeitureBps"
    | "forfeitureBaseNetOfReplacementFunding"
    | "pricePerUnitCents"
    | "fractionalUnitsAllowed"
  >,
): ForfeitureProposal {
  let unpaid = i.unpaidAtDue;
  for (const r of sortedReductions(i.reductions)) {
    if (compareIso(r.on, i.forfeitureDate) > 0) break;
    if (r.by === "MEMBER" || cfg.forfeitureBaseNetOfReplacementFunding) {
      unpaid -= r.amount;
    }
  }
  const unpaidAtForfeiture = maxBig(0n, unpaid);
  const halfOfUnpaid = roundDiv(
    unpaidAtForfeiture * BigInt(cfg.forfeitureBps),
    10_000n,
  );
  const { contributed, unreturned, unpaidReturn, preferredUnits } = i.position;
  const capitalPaid = maxBig(0n, contributed);
  const capBinding = capitalPaid < halfOfUnpaid;
  const forfeited = minBig(halfOfUnpaid, capitalPaid);
  const unreturnedDeducted = minBig(forfeited, maxBig(0n, unreturned));
  const extinguishedReturn =
    unreturned <= 0n
      ? 0n
      : roundDiv(unpaidReturn * unreturnedDeducted, unreturned);
  const unitsAfter =
    preferredUnits -
    microUnitsForAmount(
      forfeited,
      cfg.pricePerUnitCents,
      cfg.fractionalUnitsAllowed,
    );
  if (unitsAfter < 0n) {
    throw new LlcMathError(
      "FORFEIT_EXCEEDS_UNITS",
      "Forfeited units exceed the units held",
    );
  }
  return {
    unpaidAtForfeiture,
    halfOfUnpaid,
    capitalPaid,
    capBinding,
    forfeited,
    unreturnedDeducted,
    extinguishedReturn,
    contributedAfter: contributed - forfeited,
    unitsBefore: preferredUnits,
    unitsAfter,
  };
}

export interface CreditProposal {
  fundedCounted: Cents;
  poolA: Cents;
  redirected: Cents;
  poolB: Cents;
  blocked: null | "NO_ELIGIBLE_HOLDERS";
  credits: {
    holderId: string;
    clause: "A" | "B";
    amount: Cents;
    units: MicroUnits;
  }[];
}

/** R36: clause (A) to Replacement Funders (insiders redirected), clause (B) to holders on the due date by units. */
export function computeCreditAllocation(
  i: {
    forfeited: Cents;
    unpaidAtForfeiture: Cents;
    fundings: readonly {
      holderId: string;
      amount: Cents;
      isInsider: boolean;
    }[];
    holdersOnDueDate: readonly { holderId: string; units: MicroUnits }[];
  },
  cfg: Pick<Cfg, "replacementCreditBps" | "pricePerUnitCents">,
): CreditProposal {
  if (i.forfeited < 0n || i.unpaidAtForfeiture < 0n) {
    throw new LlcMathError("NEGATIVE", "Amounts must not be negative");
  }
  // One funder may fund in several tranches: sum per holder (first-appearance order).
  const byHolder = new Map<
    string,
    { holderId: string; amount: Cents; isInsider: boolean }
  >();
  for (const f of i.fundings) {
    const prev = byHolder.get(f.holderId);
    if (!prev) {
      byHolder.set(f.holderId, { ...f });
    } else if (prev.isInsider !== f.isInsider) {
      throw new LlcMathError(
        "INCONSISTENT_INSIDER",
        `Fundings by ${f.holderId} disagree on whether it is an insider`,
      );
    } else {
      prev.amount += f.amount;
    }
  }
  const fundings = [...byHolder.values()];
  const fundedTotal = fundings.reduce((s, f) => s + f.amount, 0n);
  const fundedCounted = minBig(fundedTotal, i.unpaidAtForfeiture);
  const poolA =
    i.unpaidAtForfeiture === 0n
      ? 0n
      : roundDiv(
          i.forfeited * BigInt(cfg.replacementCreditBps) * fundedCounted,
          10_000n * i.unpaidAtForfeiture,
        );
  const credits: CreditProposal["credits"] = [];
  const toUnits = (amount: Cents) =>
    microUnitsForAmount(amount, cfg.pricePerUnitCents, true);

  let redirected = 0n;
  const aCredits: CreditProposal["credits"] = [];
  if (poolA > 0n) {
    const shares = allocateProRata(
      poolA,
      fundings.map((f) => ({ key: f.holderId, weight: f.amount })),
    );
    for (const f of fundings) {
      const amount = shares.get(f.holderId) ?? 0n;
      if (f.isInsider) redirected += amount;
      else if (amount > 0n)
        aCredits.push({
          holderId: f.holderId,
          clause: "A",
          amount,
          units: toUnits(amount),
        });
    }
  }
  const poolB = i.forfeited - poolA + redirected;
  const unitsTotal = i.holdersOnDueDate.reduce((s, h) => s + h.units, 0n);
  if (poolB > 0n && unitsTotal === 0n) {
    return {
      fundedCounted,
      poolA,
      redirected,
      poolB,
      blocked: "NO_ELIGIBLE_HOLDERS",
      credits: [],
    };
  }
  credits.push(...aCredits);
  if (poolB > 0n) {
    const shares = allocateProRata(
      poolB,
      i.holdersOnDueDate.map((h) => ({ key: h.holderId, weight: h.units })),
    );
    for (const h of i.holdersOnDueDate) {
      const amount = shares.get(h.holderId) ?? 0n;
      if (amount > 0n)
        credits.push({
          holderId: h.holderId,
          clause: "B",
          amount,
          units: toUnits(amount),
        });
    }
  }
  return { fundedCounted, poolA, redirected, poolB, blocked: null, credits };
}

/**
 * R37. PAID_IN_FULL when the Balance, interest and costs are all 0 and the last
 * reduction was the member's, even if a Replacement Funder earlier funded part
 * (that part reduced the commitment, §4.9(ii)); REPLACEMENT_FUNDED when a
 * Replacement Funder's reduction brought the Balance to 0 and the forfeiture and
 * credit are confirmed.
 */
export function cureStatus(i: {
  outstandingBalance: Cents;
  interestOwed: Cents;
  costsOwed: Cents;
  lastReductionBy: "MEMBER" | "REPLACEMENT_FUNDER" | null;
  forfeitureConfirmed: boolean;
  creditConfirmed: boolean;
  forfeitureDatePassed: boolean;
}): { cured: boolean; method: "PAID_IN_FULL" | "REPLACEMENT_FUNDED" | null } {
  const notCured = { cured: false, method: null } as const;
  if (i.outstandingBalance > 0n) return notCured;
  if (i.lastReductionBy === "REPLACEMENT_FUNDER") {
    return i.forfeitureDatePassed && i.forfeitureConfirmed && i.creditConfirmed
      ? { cured: true, method: "REPLACEMENT_FUNDED" }
      : notCured;
  }
  return i.interestOwed <= 0n && i.costsOwed <= 0n
    ? { cured: true, method: "PAID_IN_FULL" }
    : notCured;
}

export type DefaultStatus = "OPEN" | "CURED" | "VOIDED";

/** R32: status ≠ VOIDED && dueOn < asOf && (curedOn === null || asOf < curedOn). */
export function isSuspended(
  d: { status: DefaultStatus; dueOn: IsoDate; curedOn: IsoDate | null },
  asOf: IsoDate,
): boolean {
  return (
    d.status !== "VOIDED" &&
    compareIso(d.dueOn, asOf) < 0 &&
    (d.curedOn === null || compareIso(asOf, d.curedOn) < 0)
  );
}

export function suspendedHolderIds(
  defaults: readonly {
    stakeholderId: string;
    status: DefaultStatus;
    dueOn: IsoDate;
    curedOn: IsoDate | null;
  }[],
  asOf: IsoDate,
): Set<string> {
  const ids = new Set<string>();
  for (const d of defaults) if (isSuspended(d, asOf)) ids.add(d.stakeholderId);
  return ids;
}
