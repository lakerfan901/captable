// Holder positions derived from immutable ledger events (R1–R8, R34, R39).

import { allocateProRata } from "./allocate";
import type { LlcEconomicsConfig } from "./config";
import { compareIso, daysBetween, type IsoDate, maxIso, minIso } from "./dates";
import { type Cents, LlcMathError, type MicroUnits, roundDiv } from "./money";

export interface ContributionEvent {
  kind: "CONTRIBUTION";
  on: IsoDate;
  seq: number;
  holderId: string;
  lotId: string;
  amount: Cents;
  units: MicroUnits;
  accrualStartOn: IsoDate;
}
export interface ForfeitureEvent {
  kind: "FORFEITURE";
  on: IsoDate;
  seq: number;
  holderId: string;
  /** positive */
  amount: Cents;
  /** positive, units cancelled */
  units: MicroUnits;
}
export interface TransferEvent {
  kind: "TRANSFER";
  on: IsoDate;
  seq: number;
  fromHolderId: string;
  toHolderId: string;
  units: MicroUnits;
}
export interface DistributionEvent {
  kind: "DISTRIBUTION";
  on: IsoDate;
  seq: number;
  distributionId: string;
  lines: readonly { holderId: string; tierC: Cents; tierD: Cents }[];
}
export type LedgerEvent =
  | ContributionEvent
  | ForfeitureEvent
  | TransferEvent
  | DistributionEvent;

export interface LotState {
  lotId: string;
  accrualStartOn: IsoDate;
  original: Cents;
  outstanding: Cents;
}
export interface HolderPosition {
  holderId: string;
  contributed: Cents;
  unreturned: Cents;
  capitalReturned: Cents;
  forfeited: Cents;
  preferredUnits: MicroUnits;
  accruedReturn: Cents;
  returnPaid: Cents;
  returnExtinguished: Cents;
  returnCarriedIn: Cents;
  returnCarriedOut: Cents;
  unpaidReturn: Cents;
  lots: LotState[];
}
export interface PositionsResult {
  asOf: IsoDate;
  holders: Map<string, HolderPosition>;
  totals: {
    contributed: Cents;
    unreturned: Cents;
    unpaidReturn: Cents;
    preferredUnits: MicroUnits;
  };
  forfeitures: {
    holderId: string;
    on: IsoDate;
    amount: Cents;
    unreturnedDeducted: Cents;
    extinguishedReturn: Cents;
    unitsBefore: MicroUnits;
    unitsAfter: MicroUnits;
  }[];
}
export interface PositionOptions {
  /** Process events with on < asOf, plus events on asOf with seq < untilSeq. Default: all events with on ≤ asOf. */
  untilSeq?: number;
  /** R8: windows during which a holder's lots do not accrue: days d with from < d ≤ (to ?? asOf). */
  accrualPauses?: readonly {
    holderId: string;
    from: IsoDate;
    to: IsoDate | null;
  }[];
}

interface Lot extends LotState {
  numer: bigint;
  accruedThrough: IsoDate;
}
interface Holder extends Omit<HolderPosition, "lots" | "accruedReturn"> {
  lots: Lot[];
}

function minBig(a: bigint, b: bigint): bigint {
  if (a <= b) return a;
  return b;
}

function mergePauses(
  windows: { from: IsoDate; to: IsoDate }[],
): { from: IsoDate; to: IsoDate }[] {
  const sorted = windows
    .filter((w) => compareIso(w.to, w.from) > 0)
    .sort((a, b) => compareIso(a.from, b.from));
  const out: { from: IsoDate; to: IsoDate }[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && compareIso(w.from, last.to) <= 0) {
      last.to = maxIso(last.to, w.to);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

export function computePositions(
  events: readonly LedgerEvent[],
  asOf: IsoDate,
  cfg: Pick<
    LlcEconomicsConfig,
    "prefReturnBps" | "dayCountBasis" | "capitalReturnLotOrder"
  >,
  opts: PositionOptions = {},
): PositionsResult {
  const bps = BigInt(cfg.prefReturnBps);
  const divisor = BigInt(cfg.dayCountBasis) * 10_000n;

  // 1. Select and order events.
  const selected = events.filter((e) => {
    const c = compareIso(e.on, asOf);
    if (c < 0) return true;
    if (c > 0) return false;
    return opts.untilSeq === undefined || e.seq < opts.untilSeq;
  });
  // Lots built from one receipt share that receipt's seq (buildCapitalLots);
  // contributions commute, so a shared seq is allowed only between
  // CONTRIBUTION events of the same holder on the same date.
  const bySeq = new Map<number, LedgerEvent>();
  for (const e of selected) {
    const prev = bySeq.get(e.seq);
    if (prev) {
      const sameReceipt =
        prev.kind === "CONTRIBUTION" &&
        e.kind === "CONTRIBUTION" &&
        prev.holderId === e.holderId &&
        prev.on === e.on;
      if (!sameReceipt) {
        throw new LlcMathError("DUPLICATE_SEQ", `Duplicate event seq ${e.seq}`);
      }
    } else {
      bySeq.set(e.seq, e);
    }
  }
  const ordered = [...selected].sort((a, b) => {
    const c = compareIso(a.on, b.on);
    if (c !== 0) return c;
    if (a.seq !== b.seq) return a.seq - b.seq;
    const la = a.kind === "CONTRIBUTION" ? a.lotId : "";
    const lb = b.kind === "CONTRIBUTION" ? b.lotId : "";
    return la < lb ? -1 : la > lb ? 1 : 0;
  });

  const pauses = new Map<string, { from: IsoDate; to: IsoDate }[]>();
  for (const p of opts.accrualPauses ?? []) {
    const list = pauses.get(p.holderId) ?? [];
    list.push({ from: p.from, to: p.to ?? asOf });
    pauses.set(p.holderId, list);
  }
  for (const [k, v] of pauses) pauses.set(k, mergePauses(v));

  const holders = new Map<string, Holder>();
  const forfeitures: PositionsResult["forfeitures"] = [];

  const holder = (id: string): Holder => {
    let h = holders.get(id);
    if (!h) {
      h = {
        holderId: id,
        contributed: 0n,
        unreturned: 0n,
        capitalReturned: 0n,
        forfeited: 0n,
        preferredUnits: 0n,
        returnPaid: 0n,
        returnExtinguished: 0n,
        returnCarriedIn: 0n,
        returnCarriedOut: 0n,
        unpaidReturn: 0n,
        lots: [],
      };
      holders.set(id, h);
    }
    return h;
  };

  const accruingDays = (holderId: string, from: IsoDate, to: IsoDate) => {
    let days = daysBetween(from, to);
    for (const w of pauses.get(holderId) ?? []) {
      const lo = maxIso(from, w.from);
      const hi = minIso(to, w.to);
      const overlap = daysBetween(lo, hi);
      if (overlap > 0) days -= overlap;
    }
    return days;
  };

  // 2. Advance a holder's lots to t.
  const advance = (h: Holder, t: IsoDate) => {
    for (const lot of h.lots) {
      const from = maxIso(lot.accruedThrough, lot.accrualStartOn);
      if (compareIso(t, from) > 0) {
        lot.numer +=
          lot.outstanding * BigInt(accruingDays(h.holderId, from, t)) * bps;
        lot.accruedThrough = t;
      }
    }
  };

  const accrued = (h: Holder): Cents =>
    roundDiv(
      h.lots.reduce((s, l) => s + l.numer, 0n),
      divisor,
    );
  const unpaid = (h: Holder): Cents =>
    accrued(h) -
    h.returnPaid -
    h.returnExtinguished -
    h.returnCarriedOut +
    h.returnCarriedIn;

  const reduceProRata = (h: Holder, amount: Cents): Map<string, Cents> => {
    const parts = allocateProRata(
      amount,
      h.lots.map((l) => ({ key: l.lotId, weight: l.outstanding })),
    );
    for (const lot of h.lots) lot.outstanding -= parts.get(lot.lotId) ?? 0n;
    h.unreturned -= amount;
    return parts;
  };

  const reduceOrdered = (h: Holder, amount: Cents, lifo: boolean) => {
    const sorted = [...h.lots].sort((a, b) => {
      const c = compareIso(a.accrualStartOn, b.accrualStartOn);
      if (c !== 0) return c;
      return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
    });
    if (lifo) sorted.reverse();
    let left = amount;
    for (const lot of sorted) {
      if (left === 0n) break;
      const take = minBig(lot.outstanding, left);
      lot.outstanding -= take;
      left -= take;
    }
    h.unreturned -= amount;
  };

  for (const e of ordered) {
    const t = e.on;
    switch (e.kind) {
      case "CONTRIBUTION": {
        const h = holder(e.holderId);
        advance(h, t);
        h.lots.push({
          lotId: e.lotId,
          accrualStartOn: e.accrualStartOn,
          original: e.amount,
          outstanding: e.amount,
          numer: 0n,
          accruedThrough: e.accrualStartOn,
        });
        h.contributed += e.amount;
        h.unreturned += e.amount;
        h.preferredUnits += e.units;
        break;
      }
      case "DISTRIBUTION": {
        for (const line of e.lines) {
          const h = holder(line.holderId);
          advance(h, t);
          if (line.tierC < 0n || line.tierD < 0n) {
            throw new LlcMathError(
              "NEGATIVE_DISTRIBUTION",
              `Negative tier amount in ${e.distributionId}`,
            );
          }
          if (line.tierC > unpaid(h)) {
            throw new LlcMathError(
              "OVERPAID_RETURN",
              `Tier (c) exceeds unpaid Preferred Return for ${h.holderId}`,
            );
          }
          if (line.tierD > h.unreturned) {
            throw new LlcMathError(
              "OVER_RETURNED",
              `Tier (d) exceeds Unreturned Capital Contributions for ${h.holderId}`,
            );
          }
          h.returnPaid += line.tierC;
          if (cfg.capitalReturnLotOrder === "PRO_RATA") {
            reduceProRata(h, line.tierD);
          } else {
            reduceOrdered(h, line.tierD, cfg.capitalReturnLotOrder === "LIFO");
          }
          h.capitalReturned += line.tierD;
        }
        break;
      }
      case "FORFEITURE": {
        const h = holder(e.holderId);
        advance(h, t);
        const x = minBig(e.amount, h.unreturned);
        const extinguished =
          h.unreturned === 0n ? 0n : roundDiv(unpaid(h) * x, h.unreturned);
        if (h.contributed - e.amount < 0n) {
          throw new LlcMathError(
            "FORFEIT_EXCEEDS_CAPITAL",
            `Forfeiture exceeds contributed capital for ${h.holderId}`,
          );
        }
        if (h.preferredUnits - e.units < 0n) {
          throw new LlcMathError(
            "FORFEIT_EXCEEDS_UNITS",
            `Forfeiture exceeds units held by ${h.holderId}`,
          );
        }
        const unitsBefore = h.preferredUnits;
        reduceProRata(h, x);
        h.returnExtinguished += extinguished;
        h.contributed -= e.amount;
        h.forfeited += e.amount;
        h.preferredUnits -= e.units;
        forfeitures.push({
          holderId: h.holderId,
          on: t,
          amount: e.amount,
          unreturnedDeducted: x,
          extinguishedReturn: extinguished,
          unitsBefore,
          unitsAfter: h.preferredUnits,
        });
        break;
      }
      case "TRANSFER": {
        const from = holder(e.fromHolderId);
        const to = holder(e.toHolderId);
        advance(from, t);
        advance(to, t);
        const n = from.preferredUnits;
        if (n === 0n || e.units > n) {
          throw new LlcMathError(
            "TRANSFER_EXCEEDS_UNITS",
            `Transfer exceeds units held by ${from.holderId}`,
          );
        }
        const movedCapital = roundDiv(from.unreturned * e.units, n);
        const parts = reduceProRata(from, movedCapital);
        for (const lot of [...from.lots]) {
          const part = parts.get(lot.lotId) ?? 0n;
          if (part <= 0n) continue;
          const start = maxIso(lot.accrualStartOn, t);
          to.lots.push({
            lotId: `${lot.lotId}>${to.holderId}@${t}`,
            accrualStartOn: start,
            original: part,
            outstanding: part,
            numer: 0n,
            accruedThrough: start,
          });
        }
        to.unreturned += movedCapital;
        const movedContributed = roundDiv(from.contributed * e.units, n);
        from.contributed -= movedContributed;
        to.contributed += movedContributed;
        const carry = roundDiv(unpaid(from) * e.units, n);
        from.returnCarriedOut += carry;
        to.returnCarriedIn += carry;
        from.preferredUnits -= e.units;
        to.preferredUnits += e.units;
        break;
      }
    }
  }

  // 8. Advance everyone to asOf and finalise.
  const result = new Map<string, HolderPosition>();
  const totals = {
    contributed: 0n,
    unreturned: 0n,
    unpaidReturn: 0n,
    preferredUnits: 0n,
  };
  for (const h of holders.values()) {
    advance(h, asOf);
    const accruedReturn = accrued(h);
    const unpaidReturn = unpaid(h);
    result.set(h.holderId, {
      holderId: h.holderId,
      contributed: h.contributed,
      unreturned: h.unreturned,
      capitalReturned: h.capitalReturned,
      forfeited: h.forfeited,
      preferredUnits: h.preferredUnits,
      accruedReturn,
      returnPaid: h.returnPaid,
      returnExtinguished: h.returnExtinguished,
      returnCarriedIn: h.returnCarriedIn,
      returnCarriedOut: h.returnCarriedOut,
      unpaidReturn,
      lots: h.lots.map((l) => ({
        lotId: l.lotId,
        accrualStartOn: l.accrualStartOn,
        original: l.original,
        outstanding: l.outstanding,
      })),
    });
    totals.contributed += h.contributed;
    totals.unreturned += h.unreturned;
    totals.unpaidReturn += unpaidReturn;
    totals.preferredUnits += h.preferredUnits;
  }
  return { asOf, holders: result, totals, forfeitures };
}
