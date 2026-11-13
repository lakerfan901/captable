// Distribution waterfall (§5.6(c)–(e)), netting on a member's line
// (§4.9(iii), §4.9(v), §9.2) and liquidation / fair value (§11.4, §7.1(ii)).
// Rules R9–R14, R16–R18, R40, R43 of docs/llc-mode/02-economics.md.

import { allocateProRata } from "./allocate";
import type { OffsetTarget } from "./config";
import type { IsoDate } from "./dates";
import { type Cents, LlcMathError, type MicroUnits, roundDiv } from "./money";

export type WaterfallErrorCode =
  | "NEGATIVE"
  | "DUPLICATE_HOLDER"
  | "BAD_BPS"
  | "NO_UNITS_IN_CLASS"
  | "EXCEEDS_UNRETURNED_CAPITAL"
  | "WATERFALL_INVARIANT"
  | "BAD_OFFSET_ORDER"
  | "NETTING_INVARIANT"
  | "INSUFFICIENT_FOR_CREDITORS"
  | "BAD_UNITS_VALUED";

function fail(code: WaterfallErrorCode, message: string): never {
  throw new LlcMathError(code, message);
}

function nonNegative(value: bigint, label: string): void {
  if (value < 0n) fail("NEGATIVE", `${label} must not be negative`);
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// Waterfall (R9–R14)
// ---------------------------------------------------------------------------

export interface WaterfallHolder {
  holderId: string;
  unpaidReturn: Cents;
  unreturned: Cents;
  preferredUnits: MicroUnits;
  commonUnits: MicroUnits;
}

export interface WaterfallLine {
  holderId: string;
  tierC: Cents;
  tierD: Cents;
  tierEPreferred: Cents;
  tierECommon: Cents;
  gross: Cents;
}

export interface WaterfallResult {
  amount: Cents;
  tierC: Cents;
  tierD: Cents;
  tierEPreferred: Cents;
  tierECommon: Cents;
  /** Sorted by holderId, one per input holder. */
  lines: WaterfallLine[];
}

/** Splits `total` across holders by `weight`; skips (all zero) when the total weight is zero. */
function splitTier(
  total: Cents,
  holders: readonly WaterfallHolder[],
  weight: (h: WaterfallHolder) => bigint,
): Map<string, bigint> {
  const items = holders.map((h) => ({ key: h.holderId, weight: weight(h) }));
  const sum = items.reduce((s, i) => s + i.weight, 0n);
  if (total === 0n || sum === 0n) {
    return new Map(items.map((i) => [i.key, 0n]));
  }
  return allocateProRata(total, items);
}

export function runWaterfall(
  amount: Cents,
  holders: readonly WaterfallHolder[],
  opts: { mode: "FULL" | "D_ONLY"; residualPreferredBps: number },
): WaterfallResult {
  nonNegative(amount, "Amount");
  const bps = opts.residualPreferredBps;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    fail("BAD_BPS", `residualPreferredBps must be 0–10000, got ${bps}`);
  }
  const seen = new Set<string>();
  let sumUnpaid = 0n;
  let sumUnreturned = 0n;
  let sumPreferredUnits = 0n;
  let sumCommonUnits = 0n;
  for (const h of holders) {
    if (seen.has(h.holderId)) {
      fail("DUPLICATE_HOLDER", `Holder ${h.holderId} appears twice`);
    }
    seen.add(h.holderId);
    nonNegative(h.unpaidReturn, `unpaidReturn of ${h.holderId}`);
    nonNegative(h.unreturned, `unreturned of ${h.holderId}`);
    nonNegative(h.preferredUnits, `preferredUnits of ${h.holderId}`);
    nonNegative(h.commonUnits, `commonUnits of ${h.holderId}`);
    sumUnpaid += h.unpaidReturn;
    sumUnreturned += h.unreturned;
    sumPreferredUnits += h.preferredUnits;
    sumCommonUnits += h.commonUnits;
  }

  let tierCTotal = 0n;
  let tierDTotal = 0n;
  let poolPreferred = 0n;
  let poolCommon = 0n;

  if (opts.mode === "D_ONLY") {
    // R13: return of unused capital is a §5.6(d) distribution only.
    if (amount > sumUnreturned) {
      fail(
        "EXCEEDS_UNRETURNED_CAPITAL",
        `Return of capital ${amount} exceeds Unreturned Capital Contributions ${sumUnreturned} (§1.15)`,
      );
    }
    tierDTotal = amount;
  } else {
    // R9: tier (c) up to all accrued and unpaid Preferred Return.
    tierCTotal = minBig(amount, sumUnpaid);
    let rest = amount - tierCTotal;
    // R10: tier (d) up to all Unreturned Capital Contributions.
    tierDTotal = minBig(rest, sumUnreturned);
    rest -= tierDTotal;
    // R11: tier (e) residual, 70/30 by default.
    if (rest > 0n) {
      const pools = allocateProRata(rest, [
        { key: "0-preferred", weight: BigInt(bps) },
        { key: "1-common", weight: BigInt(10_000 - bps) },
      ]);
      poolPreferred = pools.get("0-preferred") ?? 0n;
      poolCommon = pools.get("1-common") ?? 0n;
      if (poolPreferred > 0n && sumPreferredUnits === 0n) {
        fail(
          "NO_UNITS_IN_CLASS",
          "Residual preferred pool is positive but no Preferred Units are outstanding",
        );
      }
      if (poolCommon > 0n && sumCommonUnits === 0n) {
        fail(
          "NO_UNITS_IN_CLASS",
          "Residual common pool is positive but no Common Units are outstanding",
        );
      }
    }
  }

  const c = splitTier(tierCTotal, holders, (h) => h.unpaidReturn);
  const d = splitTier(tierDTotal, holders, (h) => h.unreturned);
  const eP = splitTier(poolPreferred, holders, (h) => h.preferredUnits);
  const eC = splitTier(poolCommon, holders, (h) => h.commonUnits);

  const lines: WaterfallLine[] = holders.map((h) => {
    const tierC = c.get(h.holderId) ?? 0n;
    const tierD = d.get(h.holderId) ?? 0n;
    const tierEPreferred = eP.get(h.holderId) ?? 0n;
    const tierECommon = eC.get(h.holderId) ?? 0n;
    return {
      holderId: h.holderId,
      tierC,
      tierD,
      tierEPreferred,
      tierECommon,
      gross: tierC + tierD + tierEPreferred + tierECommon,
    };
  });
  lines.sort((a, b) =>
    a.holderId < b.holderId ? -1 : a.holderId > b.holderId ? 1 : 0,
  );

  // Invariant: no cent created or lost.
  let sumGross = 0n;
  let sumC = 0n;
  let sumD = 0n;
  let sumEP = 0n;
  let sumEC = 0n;
  for (const line of lines) {
    sumGross += line.gross;
    sumC += line.tierC;
    sumD += line.tierD;
    sumEP += line.tierEPreferred;
    sumEC += line.tierECommon;
  }
  if (
    sumGross !== amount ||
    sumC !== tierCTotal ||
    sumD !== tierDTotal ||
    sumEP !== poolPreferred ||
    sumEC !== poolCommon ||
    tierCTotal + tierDTotal + poolPreferred + poolCommon !== amount
  ) {
    fail(
      "WATERFALL_INVARIANT",
      `Waterfall lines do not sum to the amount distributed (${sumGross} vs ${amount})`,
    );
  }

  return {
    amount,
    tierC: tierCTotal,
    tierD: tierDTotal,
    tierEPreferred: poolPreferred,
    tierECommon: poolCommon,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Netting on a member's line (R16–R18)
// ---------------------------------------------------------------------------

export interface DefaultOwed {
  memberDefaultId: string;
  dueOn: IsoDate;
  suspended: boolean;
  balance: Cents;
  interest: Cents;
  costs: Cents;
  /** true when paying everything owed would still not cure: replacement funding exists and the forfeiture or credit is not confirmed */
  cureNeedsConfirmation: boolean;
}

export interface OffsetApplication {
  memberDefaultId: string;
  toBalance: Cents;
  toInterest: Cents;
  toCosts: Cents;
  paysInFull: boolean;
}

export interface NetLine {
  gross: Cents;
  offsets: OffsetApplication[];
  defaultOffsetBalance: Cents;
  defaultOffsetInterest: Cents;
  defaultOffsetCosts: Cents;
  taxAdvanceOffset: Cents;
  net: Cents;
  /** a suspended default with cureNeedsConfirmation was paid in full and money was left over: the caller must block (E15 DEFAULT_EXCESS_HELD) */
  excessHeld: boolean;
}

const OFFSET_TARGETS: readonly OffsetTarget[] = [
  "BALANCE",
  "INTEREST",
  "COSTS",
];

/** The order must name each of BALANCE, INTEREST, COSTS exactly once. */
function assertOffsetOrder(order: readonly OffsetTarget[]): void {
  const ok =
    order.length === OFFSET_TARGETS.length &&
    OFFSET_TARGETS.every((t) => order.filter((o) => o === t).length === 1);
  if (!ok) {
    fail(
      "BAD_OFFSET_ORDER",
      `Offset order must list BALANCE, INTEREST and COSTS once each, got [${order.join(", ")}]`,
    );
  }
}

export function applyDefaultOffset(
  available: Cents,
  owed: DefaultOwed,
  order: readonly OffsetTarget[],
): OffsetApplication & { remaining: Cents } {
  assertOffsetOrder(order);
  nonNegative(available, "Available amount");
  nonNegative(owed.balance, `balance of ${owed.memberDefaultId}`);
  nonNegative(owed.interest, `interest of ${owed.memberDefaultId}`);
  nonNegative(owed.costs, `costs of ${owed.memberDefaultId}`);

  const taken: Record<OffsetTarget, Cents> = {
    BALANCE: 0n,
    INTEREST: 0n,
    COSTS: 0n,
  };
  const owedBy: Record<OffsetTarget, Cents> = {
    BALANCE: owed.balance,
    INTEREST: owed.interest,
    COSTS: owed.costs,
  };
  let remaining = available;
  for (const target of order) {
    // R18: after a cure only interest and costs are still withheld.
    if (!owed.suspended && target === "BALANCE") continue;
    const take = minBig(remaining, owedBy[target]);
    taken[target] = take;
    remaining -= take;
  }
  return {
    memberDefaultId: owed.memberDefaultId,
    toBalance: taken.BALANCE,
    toInterest: taken.INTEREST,
    toCosts: taken.COSTS,
    paysInFull:
      taken.BALANCE === owed.balance &&
      taken.INTEREST === owed.interest &&
      taken.COSTS === owed.costs,
    remaining,
  };
}

export function netDistributionLine(i: {
  gross: Cents;
  defaults: readonly DefaultOwed[];
  taxAdvanceOutstanding: Cents;
  order: readonly OffsetTarget[];
}): NetLine {
  assertOffsetOrder(i.order);
  nonNegative(i.gross, "Gross line amount");
  nonNegative(i.taxAdvanceOutstanding, "Tax advance outstanding");

  const defaults = [...i.defaults].sort((a, b) => {
    if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
    return a.memberDefaultId < b.memberDefaultId
      ? -1
      : a.memberDefaultId > b.memberDefaultId
        ? 1
        : 0;
  });

  const offsets: OffsetApplication[] = [];
  let remaining = i.gross;
  let defaultOffsetBalance = 0n;
  let defaultOffsetInterest = 0n;
  let defaultOffsetCosts = 0n;
  let heldCandidate = false;
  for (const owed of defaults) {
    const { remaining: left, ...application } = applyDefaultOffset(
      remaining,
      owed,
      i.order,
    );
    remaining = left;
    offsets.push(application);
    defaultOffsetBalance += application.toBalance;
    defaultOffsetInterest += application.toInterest;
    defaultOffsetCosts += application.toCosts;
    if (owed.suspended && owed.cureNeedsConfirmation && application.paysInFull)
      heldCandidate = true;
  }
  const excessHeld = heldCandidate && remaining > 0n;

  // R16: tax advance from whatever the default offsets left.
  const taxAdvanceOffset = minBig(remaining, i.taxAdvanceOutstanding);
  const net = remaining - taxAdvanceOffset;

  if (
    defaultOffsetBalance +
      defaultOffsetInterest +
      defaultOffsetCosts +
      taxAdvanceOffset +
      net !==
    i.gross
  ) {
    fail("NETTING_INVARIANT", "Line offsets and net do not sum to gross");
  }

  return {
    gross: i.gross,
    offsets,
    defaultOffsetBalance,
    defaultOffsetInterest,
    defaultOffsetCosts,
    taxAdvanceOffset,
    net,
    excessHeld,
  };
}

// ---------------------------------------------------------------------------
// Liquidation and fair value (R40, R43)
// ---------------------------------------------------------------------------

export function liquidationWaterfall(i: {
  cash: Cents;
  creditors: Cents;
  memberLoans: Cents;
  windDownReserve: Cents;
  holders: readonly WaterfallHolder[];
  residualPreferredBps: number;
}): { netToMembers: Cents; waterfall: WaterfallResult } {
  nonNegative(i.cash, "Cash");
  nonNegative(i.creditors, "Creditors");
  nonNegative(i.memberLoans, "Member loans");
  nonNegative(i.windDownReserve, "Wind-down reserve");
  // §11.4: (a) creditors, (b) member loans, then (c) the §5.6(c)–(e) waterfall.
  const netToMembers = i.cash - i.creditors - i.memberLoans - i.windDownReserve;
  if (netToMembers < 0n) {
    fail(
      "INSUFFICIENT_FOR_CREDITORS",
      `Cash ${i.cash} does not cover creditors, member loans and the wind-down reserve (§11.4)`,
    );
  }
  return {
    netToMembers,
    waterfall: runWaterfall(netToMembers, i.holders, {
      mode: "FULL",
      residualPreferredBps: i.residualPreferredBps,
    }),
  };
}

export function hypotheticalLiquidation(i: {
  assetFmv: Cents;
  cashOnHand: Cents;
  liabilities: Cents;
  memberLoans: Cents;
  holders: readonly WaterfallHolder[];
  residualPreferredBps: number;
}): { netToMembers: Cents; waterfall: WaterfallResult } {
  nonNegative(i.assetFmv, "Asset fair market value");
  nonNegative(i.cashOnHand, "Cash on hand");
  nonNegative(i.liabilities, "Liabilities");
  nonNegative(i.memberLoans, "Member loans");
  const raw = i.assetFmv + i.cashOnHand - i.liabilities - i.memberLoans;
  const netToMembers = raw < 0n ? 0n : raw;
  return {
    netToMembers,
    waterfall: runWaterfall(netToMembers, i.holders, {
      mode: "FULL",
      residualPreferredBps: i.residualPreferredBps,
    }),
  };
}

/** Value of `unitsValued` of the `unitsHeld` units behind `holderGross` (R43). */
export function fairValueOfUnits(
  holderGross: Cents,
  unitsValued: MicroUnits,
  unitsHeld: MicroUnits,
): Cents {
  nonNegative(holderGross, "Holder gross");
  if (unitsHeld <= 0n || unitsValued < 0n || unitsValued > unitsHeld) {
    fail(
      "BAD_UNITS_VALUED",
      `Units valued (${unitsValued}) must be between 0 and units held (${unitsHeld}), and units held must be positive`,
    );
  }
  return roundDiv(holderGross * unitsValued, unitsHeld);
}
