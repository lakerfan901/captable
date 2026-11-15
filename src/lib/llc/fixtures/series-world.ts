// A generated, internally consistent company history for the financial-series
// tests (04-investor-portal.md P12). Imported only by tests.
//
// Built on Scenario S (02-economics.md D.0: holders A, B, C and the Common
// Member M, the same receipts and configuration), then extended with a seeded
// pseudo-random history: monthly revenue with a gap month, expenses (with a
// reversal), reserves, Management Fee payments, a member loan, quarterly
// distributions whose tiers are drawn within each holder's position (so
// `computePositions` accepts them), a holder D admitted mid-history by a
// receipt and a holder E admitted by a transfer from B.

import type {
  PeriodDistributionRow,
  PeriodManagerPaymentRow,
} from "../../../server/llc/economics/report-data.logic";
import type { StatementCommitment } from "../../../server/llc/economics/statements.logic";
import type { CashLedger } from "../available-cash";
import { addDays, addMonths, compareIso, type IsoDate } from "../dates";
import { monthEnd, monthsBetween } from "../financial-periods";
import type {
  AsOfFacts,
  HolderSeriesRows,
  MemberLoanRows,
  SeriesInput,
} from "../financial-series-build";
import { managementFeeForMonth, type RevenueMonth } from "../management-fee";
import type { Cents, MicroUnits } from "../money";
import {
  computePositions,
  type DistributionEvent,
  type LedgerEvent,
  type TransferEvent,
} from "../positions";
import {
  SCENARIO_S_COMMON,
  SCENARIO_S_CONFIG,
  SCENARIO_S_EVENTS,
  SCENARIO_S_RECEIPTS,
} from "./scenario-s";

/** mulberry32: a small deterministic PRNG (no dependency). */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) =>
    lo + Math.floor(next() * (hi - lo + 1));
  return {
    int,
    big: (lo: number, hi: number) => BigInt(int(lo, hi)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T,
  };
}

const U = 1_000_000n;
export const INCEPTION = "2026-11-01";
const CATEGORIES = [
  "COLOCATION",
  "EQUIPMENT_ACQUISITION",
  "INSURANCE",
  "POWER",
  "PROFESSIONAL_FEES",
] as const;
const RESERVE_KINDS = [
  "EQUIPMENT_REPAIR_AND_REPLACEMENT",
  "WIND_DOWN",
] as const;

const dayOf = (month: IsoDate, day: number): IsoDate =>
  `${month.slice(0, 8)}${String(day).padStart(2, "0")}`;

export interface World {
  input: SeriesInput;
  inception: IsoDate;
  lastMonth: IsoDate;
  /** the date a future-dated expense and distribution were placed at (in-progress worlds) */
  futureOn: IsoDate | null;
  holderIds: string[];
}

export interface WorldOptions {
  /** number of months from November 2026 (default 13–24 by seed) */
  months?: number;
  /** today falls on the 14th of the last month, with rows dated after today in it */
  inProgress?: boolean;
}

export function generateWorld(seed: number, opts: WorldOptions = {}): World {
  const r = prng(seed);
  const n = opts.months ?? r.int(13, 24);
  const lastMonth = addMonths(INCEPTION, n - 1);
  const today = opts.inProgress
    ? dayOf(lastMonth, 14)
    : addDays(monthEnd(lastMonth), r.int(1, 20));
  const cfg = SCENARIO_S_CONFIG;
  const holderNames = new Map<string, { name: string; isInsider: boolean }>([
    ["A", { name: "Holder A", isInsider: true }],
    ["B", { name: "Holder B", isInsider: false }],
    ["C", { name: "Holder C", isInsider: false }],
    ["D", { name: "Holder D", isInsider: false }],
    ["E", { name: "Holder E", isInsider: false }],
    ["M", { name: "Common Member", isInsider: true }],
  ]);

  const events: LedgerEvent[] = [...SCENARIO_S_EVENTS];
  let seq = 100;
  const rows = new Map<string, HolderSeriesRows>();
  const rowsOf = (id: string): HolderSeriesRows => {
    let h = rows.get(id);
    if (!h) {
      h = {
        holderId: id,
        name: holderNames.get(id)?.name ?? id,
        receipts: [],
        distributions: [],
        transfers: [],
        advances: [],
      };
      rows.set(id, h);
    }
    return h;
  };
  const receipts: { holderId: string; on: IsoDate; amount: Cents }[] = [];
  for (const rc of SCENARIO_S_RECEIPTS) {
    (rowsOf(rc.holderId).receipts as unknown[]).push({
      id: rc.receiptId,
      kind: rc.kind,
      on: rc.on,
      amount: rc.amount,
      units: rc.units,
    });
    receipts.push({ holderId: rc.holderId, on: rc.on, amount: rc.amount });
  }
  rowsOf("M");

  // Holder D: admitted mid-history by an Initial Installment.
  const dMonthIndex = Math.max(4, Math.floor(n / 2));
  const dOn = dayOf(addMonths(INCEPTION, dMonthIndex), r.int(3, 12));
  const dAmount = r.big(50, 300) * 100_000n;
  seq += 1;
  events.push({
    kind: "CONTRIBUTION",
    on: dOn,
    seq,
    holderId: "D",
    lotId: "d1:rest",
    amount: dAmount,
    units: (dAmount / 100_000n) * U,
    accrualStartOn: dOn,
  });
  (rowsOf("D").receipts as unknown[]).push({
    id: "d1",
    kind: "INITIAL",
    on: dOn,
    amount: dAmount,
    units: (dAmount / 100_000n) * U,
  });
  receipts.push({ holderId: "D", on: dOn, amount: dAmount });
  const commitmentOf = new Map<string, Cents>([
    ["A", 10_000_000n],
    ["B", 25_000_000n],
    ["C", 10_000_000n],
    ["D", dAmount + r.big(0, 50) * 100_000n],
  ]);

  // Cash ledger and the other period-economics inputs.
  const months: RevenueMonth[] = [];
  const utilization: { month: IsoDate; utilizationBps: number | null }[] = [];
  const expenses: CashLedger["expenses"][number][] = [];
  const reserves: CashLedger["reserves"][number][] = [];
  const managerPayments: PeriodManagerPaymentRow[] = [];
  const distributions: PeriodDistributionRow[] = [];
  const cashDistributions: CashLedger["distributions"][number][] = [];
  const loanPayments: SeriesInput["economics"]["loanPayments"][number][] = [];
  const cashLoanPayments: CashLedger["loanPayments"][number][] = [];
  const loanProceeds: CashLedger["loanProceeds"][number][] = [];
  const memberLoans: MemberLoanRows[] = [];
  const reserveBal = new Map<string, Cents>();
  const gapMonth = r.int(3, n - 2); // a month without a revenue row
  const transferMonth = r.int(3, n - 3);
  let distNumber = 0;
  let mpId = 0;
  let futureOn: IsoDate | null = null;

  reserves.push({
    on: "2026-12-01",
    kind: "MINIMUM_OPERATING",
    type: "ESTABLISH",
    amount: 5_000_000n,
    fundingSource: "CAPITAL_CONTRIBUTIONS",
    releaseTo: null,
  });

  for (let i = 0; i < n; i++) {
    const month = addMonths(INCEPTION, i);
    const last = i === n - 1;
    // Revenue (none before the first full month, none in the gap month).
    if (i >= 1 && i !== gapMonth) {
      const receiptsC = r.big(2_000_000, 9_000_000);
      const fees = r.big(0, Number(receiptsC / 5n));
      months.push({
        month,
        customerReceipts: receiptsC,
        passThroughFees: fees,
        otherIncome: r.chance(0.3) ? r.big(0, 50_000) : 0n,
        assetSaleProceeds: r.chance(0.1) ? r.big(100_000, 900_000) : 0n,
        insuranceProceeds: r.chance(0.05) ? r.big(10_000, 90_000) : 0n,
        managementFee: managementFeeForMonth(
          receiptsC - fees,
          cfg.managementFeeBps,
        ),
      });
      utilization.push({
        month,
        utilizationBps: r.chance(0.6) ? r.int(0, 10_000) : null,
      });
    }

    // Expenses, one reversal now and then.
    const count = r.int(0, 4);
    for (let k = 0; k < count; k++) {
      const row = {
        on: dayOf(month, r.int(1, last && opts.inProgress ? 14 : 28)),
        amount: r.big(10_000, 2_000_000),
        fundingSource: r.chance(0.7)
          ? ("OPERATING_CASH" as const)
          : ("CAPITAL_CONTRIBUTIONS" as const),
        category: r.pick(CATEGORIES),
        countsTowardOrgCap: i < 3 && r.chance(0.3),
      };
      expenses.push(row);
      if (r.chance(0.1)) expenses.push({ ...row, amount: -row.amount });
    }

    // Reserves: establish or release within the balance of that kind and pool.
    if (i >= 2 && r.chance(0.5)) {
      const kind = r.pick(RESERVE_KINDS);
      const key = `${kind}|OPERATING_CASH`;
      const bal = reserveBal.get(key) ?? 0n;
      const on = dayOf(month, r.int(1, last && opts.inProgress ? 14 : 28));
      if (bal > 0n && r.chance(0.4)) {
        const amount = (bal * r.big(1, 100)) / 100n;
        if (amount > 0n) {
          reserves.push({
            on,
            kind,
            type: "RELEASE",
            amount,
            fundingSource: "OPERATING_CASH",
            releaseTo: null,
          });
          reserveBal.set(key, bal - amount);
        }
      } else {
        const amount = r.big(10_000, 500_000);
        reserves.push({
          on,
          kind,
          type: "ESTABLISH",
          amount,
          fundingSource: "OPERATING_CASH",
          releaseTo: null,
        });
        reserveBal.set(key, bal + amount);
      }
    }

    // Management Fee paid the month after each quarter; other Manager payments.
    if (i % 3 === 1 && i > 1) {
      const accrued = months
        .filter(
          (m) =>
            compareIso(m.month, addMonths(month, -4)) >= 0 &&
            compareIso(m.month, addMonths(month, -1)) <= 0,
        )
        .reduce((a, m) => a + m.managementFee, 0n);
      managerPayments.push({
        id: `mp${++mpId}`,
        paidOn: dayOf(month, r.int(1, 10)),
        payee: "Manager LLC",
        category: "MANAGEMENT_FEE",
        amountCents: (accrued * r.big(50, 100)) / 100n,
        countsTowardOrgCap: false,
        memo: null,
        resolutionId: null,
      });
    }
    if (r.chance(0.3)) {
      managerPayments.push({
        id: `mp${++mpId}`,
        paidOn: dayOf(month, r.int(1, last && opts.inProgress ? 14 : 28)),
        payee: "Manager LLC",
        category: r.pick([
          "EXPENSE_REIMBURSEMENT",
          "PURCHASING_AGENT_PASS_THROUGH",
        ]),
        amountCents: r.big(1_000, 300_000),
        countsTowardOrgCap: i < 3 && r.chance(0.5),
        memo: r.chance(0.5) ? "memo" : null,
        resolutionId: null,
      });
    }

    // A member loan from A.
    if (i === 4) {
      const madeOn = dayOf(month, 5);
      memberLoans.push({
        loan: {
          madeOn,
          maturityOn: addMonths(madeOn, 12),
          principalCents: 1_000_000n,
          interestBps: 1000,
        },
        payments: [],
      });
      loanProceeds.push({ on: madeOn, amount: 1_000_000n });
    }
    if ((i === 6 || i === 9) && memberLoans[0]) {
      const p = {
        paidOn: dayOf(month, 20),
        principalCents: 300_000n,
        interestCents: r.big(1_000, 20_000),
      };
      (memberLoans[0].payments as unknown[]).push(p);
      loanPayments.push({
        lenderStakeholderId: "A",
        paidOn: p.paidOn,
        principal: p.principalCents,
        interest: p.interestCents,
      });
      cashLoanPayments.push({
        on: p.paidOn,
        principal: p.principalCents,
        interest: p.interestCents,
        fundingSource: "OPERATING_CASH",
      });
    }

    // Transfer B → E (E admitted by transfer), before this month's distribution.
    if (i === transferMonth) {
      const on = dayOf(month, 12);
      const pos = computePositions(events, on, cfg, { untilSeq: seq + 1 });
      const bUnits = pos.holders.get("B")?.preferredUnits ?? 0n;
      const units = (bUnits * r.big(10, 60)) / 100n;
      if (units > 0n) {
        seq += 1;
        const t: TransferEvent = {
          kind: "TRANSFER",
          on,
          seq,
          fromHolderId: "B",
          toHolderId: "E",
          units,
        };
        events.push(t);
        (rowsOf("B").transfers as unknown[]).push({
          id: `t${seq}`,
          on,
          direction: "OUT",
          counterparty: "Holder E",
          units,
        });
        (rowsOf("E").transfers as unknown[]).push({
          id: `t${seq}`,
          on,
          direction: "IN",
          counterparty: "Holder B",
          units,
        });
      }
    }

    // Quarterly distribution (and one dated after today in an in-progress world).
    const distDays: number[] = [];
    if (i >= 3 && i % 3 === 0) distDays.push(r.int(15, 25));
    if (last && opts.inProgress) {
      distDays.push(25);
      futureOn = dayOf(month, 25);
      expenses.push({
        on: dayOf(month, 26),
        amount: 777_700n,
        fundingSource: "OPERATING_CASH",
        category: "COLOCATION",
        countsTowardOrgCap: false,
      });
    }
    for (const day of distDays) {
      const on = dayOf(month, day);
      seq += 1;
      const pos = computePositions(events, on, cfg, { untilSeq: seq });
      const lines: {
        holderId: string;
        tierC: Cents;
        tierD: Cents;
        tierEPreferred: Cents;
        tierECommon: Cents;
      }[] = [];
      for (const h of [...pos.holders.values()].sort((a, b) =>
        a.holderId < b.holderId ? -1 : 1,
      )) {
        if (h.preferredUnits === 0n && h.unpaidReturn <= 0n) continue;
        lines.push({
          holderId: h.holderId,
          tierC:
            h.unpaidReturn > 0n ? (h.unpaidReturn * r.big(0, 100)) / 100n : 0n,
          tierD: (h.unreturned * r.big(0, 25)) / 100n,
          tierEPreferred: r.chance(0.5) ? r.big(0, 200_000) : 0n,
          tierECommon: 0n,
        });
      }
      for (const c of SCENARIO_S_COMMON) {
        lines.push({
          holderId: c.holderId,
          tierC: 0n,
          tierD: 0n,
          tierEPreferred: 0n,
          tierECommon: r.big(0, 300_000),
        });
      }
      distNumber += 1;
      const id = `dist${distNumber}`;
      const event: DistributionEvent = {
        kind: "DISTRIBUTION",
        on,
        seq,
        distributionId: id,
        lines: lines
          .filter((l) => holderNames.has(l.holderId) && l.holderId !== "M")
          .map((l) => ({
            holderId: l.holderId,
            tierC: l.tierC,
            tierD: l.tierD,
          })),
      };
      events.push(event);
      const tot = { c: 0n, d: 0n, ep: 0n, ec: 0n, gross: 0n, net: 0n };
      const outLines: PeriodDistributionRow["lines"] = [];
      for (const l of lines) {
        const gross = l.tierC + l.tierD + l.tierEPreferred + l.tierECommon;
        const defaultOffset = r.chance(0.2) ? gross / 10n : 0n;
        const taxAdvanceOffset = r.chance(0.2) ? gross / 20n : 0n;
        const net = gross - defaultOffset - taxAdvanceOffset;
        tot.c += l.tierC;
        tot.d += l.tierD;
        tot.ep += l.tierEPreferred;
        tot.ec += l.tierECommon;
        tot.gross += gross;
        tot.net += net;
        outLines.push({ stakeholderId: l.holderId, gross, net });
        (rowsOf(l.holderId).distributions as unknown[]).push({
          distributionId: id,
          number: distNumber,
          type: "OPERATING",
          paymentDate: on,
          tierC: l.tierC,
          tierD: l.tierD,
          tierEPreferred: l.tierEPreferred,
          tierECommon: l.tierECommon,
          gross,
          defaultOffset,
          taxAdvanceOffset,
          net,
        });
      }
      distributions.push({
        id,
        number: distNumber,
        type: "OPERATING",
        paymentDate: on,
        gross: tot.gross,
        tierC: tot.c,
        tierD: tot.d,
        tierEPreferred: tot.ep,
        tierECommon: tot.ec,
        net: tot.net,
        lines: outLines,
      });
      cashDistributions.push({ on, type: "OPERATING", gross: tot.gross });
    }
  }

  const ledger: CashLedger = {
    months,
    expenses,
    reserves,
    defaultIncome: [],
    loanPayments: cashLoanPayments,
    loanProceeds,
    distributions: cashDistributions,
    capitalReceived: receipts.map((x) => ({ on: x.on, amount: x.amount })),
  };

  // As-of facts: every month end from the month before inception, and today.
  const factsAt = (asOf: IsoDate): AsOfFacts => {
    const commitments = new Map<string, StatementCommitment | null>();
    for (const [id, committed] of commitmentOf) {
      const mine = receipts.filter(
        (x) => x.holderId === id && compareIso(x.on, asOf) <= 0,
      );
      if (mine.length === 0) continue;
      const paid = mine.reduce((a, x) => a + x.amount, 0n);
      commitments.set(id, {
        committed,
        paid,
        uncalled: committed - paid,
        calledOutstanding: 0n,
      });
    }
    const commonUnits = new Map<string, MicroUnits>();
    if (compareIso(asOf, INCEPTION) >= 0) {
      for (const c of SCENARIO_S_COMMON) commonUnits.set(c.holderId, c.units);
    }
    return { commitments, commonUnits };
  };
  const facts = new Map<IsoDate, AsOfFacts>();
  for (const m of monthsBetween(addMonths(INCEPTION, -1), lastMonth)) {
    facts.set(monthEnd(m), factsAt(monthEnd(m)));
  }
  facts.set(today, factsAt(today));

  const input: SeriesInput = {
    today,
    economics: {
      ledger,
      utilization,
      managerPayments,
      distributions,
      loanPayments,
      holders: holderNames,
      includeInsiderDistributions: true,
      minimumOperatingReserve: 5_000_000n,
      orgExpenseCap: 4_000_000n,
    },
    events,
    positionsConfig: cfg,
    accrualPauses: [],
    memberLoans,
    holders: [...rows.values()],
    facts,
  };
  return {
    input,
    inception: INCEPTION,
    lastMonth,
    futureOn,
    holderIds: [...holderNames.keys()],
  };
}
