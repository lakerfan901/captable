/**
 * Pure parts of the economics ledger loader (02-economics.md E7): mapping of
 * FOUNDATION receipts to library events, the same-day order (`seq`), netting
 * of Call Notice allocations, the holdings cross-check and the waterfall
 * holder rows. Relative imports only; no Prisma, no `@/`.
 */
import { compareIso, type IsoDate } from "../../../lib/llc/dates";
import type { Cents, MicroUnits } from "../../../lib/llc/money";
import type { LedgerEvent, PositionsResult } from "../../../lib/llc/positions";
import {
  type AllocationRow,
  buildCapitalLots,
  type ReceiptKind,
  type ReceiptRow,
} from "../../../lib/llc/preferred-return";
import type { WaterfallHolder } from "../../../lib/llc/waterfall";

/** A non-void, applied FOUNDATION receipt of the Preferred class, normalised. */
export interface LedgerReceipt {
  id: string;
  stakeholderId: string;
  kind: ReceiptKind | "FORFEITURE";
  receivedOn: IsoDate;
  appliedOn: IsoDate;
  appliedCents: Cents;
  unitsIssued: MicroUnits;
  prefReturnStartDate: IsoDate | null;
  createdAt: Date;
}

/** A `CallNoticeAllocation` row (negative `amountCents` on a reversal). */
export interface LedgerAllocation {
  capitalReceiptId: string;
  amountCents: Cents;
  prefReturnStartOn: IsoDate;
}

interface RawBase {
  id: string;
  on: IsoDate;
  createdAt: Date;
}

export type RawLedgerItem =
  | (RawBase & {
      type: "RECEIPT";
      /** Distribution whose §4.9(iii) offset created this receipt, if any. */
      createdByDistributionId: string | null;
      receipt: Omit<ReceiptRow, "seq">;
    })
  | (RawBase & {
      type: "FORFEITURE";
      holderId: string;
      amount: Cents;
      units: MicroUnits;
    })
  | (RawBase & {
      type: "TRANSFER";
      fromHolderId: string;
      toHolderId: string;
      units: MicroUnits;
    })
  | (RawBase & {
      type: "DISTRIBUTION";
      number: number;
      lines: readonly { holderId: string; tierC: Cents; tierD: Cents }[];
    });

/**
 * FOUNDATION receipts → raw ledger items. `INITIAL`, `BALANCE`,
 * `REPLACEMENT`, `CREDIT` with `appliedCents > 0` become contributions
 * (`on = appliedOn`, start `prefReturnStartDate ?? appliedOn`); `FORFEITURE`
 * with `appliedCents < 0` becomes a forfeiture (`on = receivedOn`, positive
 * amount and units). Everything else (unapplied rows) is skipped.
 */
export function receiptsToEvents(
  receipts: readonly LedgerReceipt[],
  offsetReceiptDistribution: ReadonlyMap<string, string> = new Map(),
): RawLedgerItem[] {
  const out: RawLedgerItem[] = [];
  for (const r of receipts) {
    if (r.kind === "FORFEITURE") {
      if (r.appliedCents >= 0n) continue;
      out.push({
        type: "FORFEITURE",
        id: r.id,
        on: r.receivedOn,
        createdAt: r.createdAt,
        holderId: r.stakeholderId,
        amount: -r.appliedCents,
        units: -r.unitsIssued,
      });
      continue;
    }
    if (r.appliedCents <= 0n) continue;
    out.push({
      type: "RECEIPT",
      id: r.id,
      on: r.appliedOn,
      createdAt: r.createdAt,
      createdByDistributionId: offsetReceiptDistribution.get(r.id) ?? null,
      receipt: {
        receiptId: r.id,
        holderId: r.stakeholderId,
        kind: r.kind,
        on: r.appliedOn,
        receivedOn: r.receivedOn,
        amount: r.appliedCents,
        units: r.unitsIssued,
        prefReturnStartOn: r.prefReturnStartDate ?? r.appliedOn,
      },
    });
  }
  return out;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCreated(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return compareText(a.id, b.id);
}

/**
 * Same-day order: by date; within a date (1) contributions not created by a
 * distribution, forfeitures, transfers — by `createdAt`, then id; (2)
 * distributions by `number`, each immediately followed by the contributions
 * its offsets created. `seq` = index after this sort.
 */
export function assignSeq<T extends RawLedgerItem>(
  raw: readonly T[],
): (T & { seq: number })[] {
  const distributions = new Map<string, { on: IsoDate; number: number }>();
  for (const item of raw) {
    if (item.type === "DISTRIBUTION") {
      distributions.set(item.id, { on: item.on, number: item.number });
    }
  }
  const key = (item: T) => {
    if (item.type === "DISTRIBUTION") {
      return { group: 2, number: item.number, sub: 0 };
    }
    if (item.type === "RECEIPT" && item.createdByDistributionId !== null) {
      const parent = distributions.get(item.createdByDistributionId);
      if (parent && parent.on === item.on) {
        return { group: 2, number: parent.number, sub: 1 };
      }
    }
    return { group: 1, number: 0, sub: 0 };
  };
  const sorted = [...raw].sort((a, b) => {
    const d = compareIso(a.on, b.on);
    if (d !== 0) return d;
    const ka = key(a);
    const kb = key(b);
    if (ka.group !== kb.group) return ka.group - kb.group;
    if (ka.number !== kb.number) return ka.number - kb.number;
    if (ka.sub !== kb.sub) return ka.sub - kb.sub;
    return compareCreated(a, b);
  });
  return sorted.map((item, seq) => ({ ...item, seq }));
}

/** Net allocations per (receipt, start date) after reversals; only positive nets, in a stable order. */
export function netAllocations(
  rows: readonly LedgerAllocation[],
): AllocationRow[] {
  const net = new Map<string, AllocationRow>();
  for (const r of rows) {
    const k = `${r.capitalReceiptId}\u0000${r.prefReturnStartOn}`;
    const prev = net.get(k);
    if (prev) {
      prev.amount += r.amountCents;
    } else {
      net.set(k, {
        receiptId: r.capitalReceiptId,
        amount: r.amountCents,
        prefReturnStartOn: r.prefReturnStartOn,
      });
    }
  }
  return [...net.values()]
    .filter((a) => a.amount > 0n)
    .sort((a, b) => {
      const r = compareText(a.receiptId, b.receiptId);
      if (r !== 0) return r;
      return compareIso(a.prefReturnStartOn, b.prefReturnStartOn);
    });
}

/** Orders the raw items, assigns `seq` and expands receipts into capital lots. */
export function buildLedgerEvents(
  raw: readonly RawLedgerItem[],
  allocations: readonly AllocationRow[],
): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const item of assignSeq(raw)) {
    switch (item.type) {
      case "RECEIPT":
        out.push(
          ...buildCapitalLots(
            [{ ...item.receipt, seq: item.seq }],
            allocations,
          ),
        );
        break;
      case "FORFEITURE":
        out.push({
          kind: "FORFEITURE",
          on: item.on,
          seq: item.seq,
          holderId: item.holderId,
          amount: item.amount,
          units: item.units,
        });
        break;
      case "TRANSFER":
        out.push({
          kind: "TRANSFER",
          on: item.on,
          seq: item.seq,
          fromHolderId: item.fromHolderId,
          toHolderId: item.toHolderId,
          units: item.units,
        });
        break;
      case "DISTRIBUTION":
        out.push({
          kind: "DISTRIBUTION",
          on: item.on,
          seq: item.seq,
          distributionId: item.id,
          lines: item.lines,
        });
        break;
    }
  }
  return out;
}

/** Preferred holdings per stakeholder from FOUNDATION's `getMemberPositions`. */
export interface FoundationHolding {
  stakeholderId: string;
  units: MicroUnits;
  capitalCents: Cents;
}

/**
 * Cross-check (FOUNDATION B20): per stakeholder on either side, engine
 * `preferredUnits` vs FOUNDATION `units` and `contributed` vs `capitalCents`;
 * a stakeholder missing on one side counts as 0. Returns the mismatching
 * stakeholder ids, sorted.
 */
export function findLedgerMismatches(
  positions: Pick<PositionsResult, "holders">,
  foundation: readonly FoundationHolding[],
): string[] {
  const theirs = new Map<string, { units: MicroUnits; capital: Cents }>();
  for (const row of foundation) {
    const prev = theirs.get(row.stakeholderId) ?? { units: 0n, capital: 0n };
    theirs.set(row.stakeholderId, {
      units: prev.units + row.units,
      capital: prev.capital + row.capitalCents,
    });
  }
  const ids = new Set<string>([...theirs.keys(), ...positions.holders.keys()]);
  const out: string[] = [];
  for (const id of ids) {
    const mine = positions.holders.get(id);
    const other = theirs.get(id);
    const units = mine?.preferredUnits ?? 0n;
    const capital = mine?.contributed ?? 0n;
    if (units !== (other?.units ?? 0n) || capital !== (other?.capital ?? 0n)) {
      out.push(id);
    }
  }
  return out.sort(compareText);
}

/** One row per stakeholder with Preferred or Common Units, sorted by id. */
export function buildWaterfallHolders(
  positions: Pick<PositionsResult, "holders">,
  commonUnits: ReadonlyMap<string, MicroUnits>,
): WaterfallHolder[] {
  const ids = new Set<string>([
    ...positions.holders.keys(),
    ...commonUnits.keys(),
  ]);
  const out: WaterfallHolder[] = [];
  for (const id of [...ids].sort(compareText)) {
    const p = positions.holders.get(id);
    const preferredUnits = p?.preferredUnits ?? 0n;
    const common = commonUnits.get(id) ?? 0n;
    if (preferredUnits === 0n && common === 0n) continue;
    out.push({
      holderId: id,
      unpaidReturn: p?.unpaidReturn ?? 0n,
      unreturned: p?.unreturned ?? 0n,
      preferredUnits,
      commonUnits: common,
    });
  }
  return out;
}
