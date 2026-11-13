// Available Cash (§1.15, R20), reserves (§5.6(a), R21), unused capital,
// organizational expense cap (§6.21, R23) and member-loan interest (§4.6, R25).

import {
  addDays,
  addMonths,
  compareIso,
  daysBetween,
  type IsoDate,
} from "./dates";
import { grossRevenue, type RevenueMonth } from "./management-fee";
import { type Cents, LlcMathError, roundDiv } from "./money";

type Pool = "OPERATING_CASH" | "CAPITAL_CONTRIBUTIONS";

export interface CashLedger {
  months: readonly RevenueMonth[];
  expenses: readonly {
    on: IsoDate;
    amount: Cents;
    fundingSource: Pool;
    category: string;
    countsTowardOrgCap: boolean;
  }[];
  reserves: readonly {
    on: IsoDate;
    kind: string;
    type: "ESTABLISH" | "RELEASE";
    amount: Cents;
    fundingSource: Pool;
    releaseTo: Pool | null;
  }[];
  /** interest + costs collected from Defaulting Members */
  defaultIncome: readonly { on: IsoDate; amount: Cents }[];
  loanPayments: readonly {
    on: IsoDate;
    principal: Cents;
    interest: Cents;
    fundingSource: Pool;
  }[];
  /** member loans received (go to the capital pool) */
  loanProceeds: readonly { on: IsoDate; amount: Cents }[];
  /** finalized, unreversed; `on` = periodEnd */
  distributions: readonly {
    on: IsoDate;
    type: "OPERATING" | "RETURN_OF_UNUSED_CAPITAL" | "SALE_OR_LIQUIDATION";
    gross: Cents;
  }[];
  /** every receipt except kind CREDIT */
  capitalReceived: readonly { on: IsoDate; amount: Cents }[];
}

export interface AvailableCashResult {
  asOf: IsoDate;
  inflows: {
    grossRevenue: Cents;
    otherIncome: Cents;
    assetSaleProceeds: Cents;
    insuranceProceeds: Cents;
    defaultIncome: Cents;
    crossToOperating: Cents;
  };
  outflows: {
    operatingExpenses: Cents;
    managementFee: Cents;
    loanService: Cents;
    crossToCapital: Cents;
  };
  reservesFromOperatingCash: Cents; // net balance
  priorDistributions: Cents;
  raw: Cents; // may be negative
  availableCash: Cents; // max(0, raw)
}

const onOrBefore = (d: IsoDate, asOf: IsoDate) => compareIso(d, asOf) <= 0;
const monthComplete = (month: IsoDate, asOf: IsoDate) =>
  onOrBefore(addDays(addMonths(month, 1), -1), asOf);
const sum = <T>(rows: readonly T[], f: (r: T) => Cents): Cents =>
  rows.reduce((acc, r) => acc + f(r), 0n);

function crossFlows(reserves: CashLedger["reserves"], asOf: IsoDate) {
  let crossToOperating = 0n;
  let crossToCapital = 0n;
  for (const r of reserves) {
    if (r.type !== "RELEASE" || !onOrBefore(r.on, asOf)) continue;
    const to = r.releaseTo ?? r.fundingSource;
    if (r.fundingSource === "CAPITAL_CONTRIBUTIONS" && to === "OPERATING_CASH")
      crossToOperating += r.amount;
    if (r.fundingSource === "OPERATING_CASH" && to === "CAPITAL_CONTRIBUTIONS")
      crossToCapital += r.amount;
  }
  return { crossToOperating, crossToCapital };
}

/** R21: net reserve balance per kind and funding pool. A RELEASE above that pool's balance throws OVER_RELEASE. */
export function reserveBalances(
  reserves: CashLedger["reserves"],
  asOf: IsoDate,
): {
  byKind: Map<string, { operating: Cents; capital: Cents; total: Cents }>;
  operating: Cents;
  capital: Cents;
  total: Cents;
} {
  const rows = reserves
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => onOrBefore(r.on, asOf))
    .sort((a, b) => compareIso(a.r.on, b.r.on) || a.i - b.i);
  const byKind = new Map<
    string,
    { operating: Cents; capital: Cents; total: Cents }
  >();
  let operating = 0n;
  let capital = 0n;
  for (const { r } of rows) {
    if (r.amount < 0n) {
      throw new LlcMathError(
        "NEGATIVE_AMOUNT",
        "Reserve amounts must be non-negative",
      );
    }
    const k = byKind.get(r.kind) ?? { operating: 0n, capital: 0n, total: 0n };
    const isOp = r.fundingSource === "OPERATING_CASH";
    const signed = r.type === "ESTABLISH" ? r.amount : -r.amount;
    const poolBalance = isOp ? k.operating : k.capital;
    if (poolBalance + signed < 0n) {
      throw new LlcMathError(
        "OVER_RELEASE",
        `Release of ${r.amount} from ${r.kind} (${r.fundingSource}) exceeds its balance of ${poolBalance}`,
      );
    }
    if (isOp) {
      k.operating += signed;
      operating += signed;
    } else {
      k.capital += signed;
      capital += signed;
    }
    k.total = k.operating + k.capital;
    byKind.set(r.kind, k);
  }
  return { byKind, operating, capital, total: operating + capital };
}

/** R20: cumulative Available Cash. A month counts when its last day ≤ asOf; dated rows when on ≤ asOf. */
export function computeAvailableCash(
  l: CashLedger,
  asOf: IsoDate,
): AvailableCashResult {
  const months = l.months.filter((m) => monthComplete(m.month, asOf));
  const { crossToOperating, crossToCapital } = crossFlows(l.reserves, asOf);
  const inflows = {
    grossRevenue: sum(months, grossRevenue),
    otherIncome: sum(months, (m) => m.otherIncome),
    assetSaleProceeds: sum(months, (m) => m.assetSaleProceeds),
    insuranceProceeds: sum(months, (m) => m.insuranceProceeds),
    defaultIncome: sum(
      l.defaultIncome.filter((r) => onOrBefore(r.on, asOf)),
      (r) => r.amount,
    ),
    crossToOperating,
  };
  const outflows = {
    operatingExpenses: sum(
      l.expenses.filter(
        (e) => e.fundingSource === "OPERATING_CASH" && onOrBefore(e.on, asOf),
      ),
      (e) => e.amount,
    ),
    managementFee: sum(months, (m) => m.managementFee),
    loanService: sum(
      l.loanPayments.filter(
        (p) => p.fundingSource === "OPERATING_CASH" && onOrBefore(p.on, asOf),
      ),
      (p) => p.principal + p.interest,
    ),
    crossToCapital,
  };
  const opReserve = reserveBalances(l.reserves, asOf).operating;
  const priorDistributions = sum(
    l.distributions.filter(
      (d) =>
        (d.type === "OPERATING" || d.type === "SALE_OR_LIQUIDATION") &&
        onOrBefore(d.on, asOf),
    ),
    (d) => d.gross,
  );
  const raw =
    inflows.grossRevenue +
    inflows.otherIncome +
    inflows.assetSaleProceeds +
    inflows.insuranceProceeds +
    inflows.defaultIncome +
    crossToOperating -
    outflows.operatingExpenses -
    outflows.managementFee -
    outflows.loanService -
    crossToCapital -
    opReserve -
    priorDistributions;
  return {
    asOf,
    inflows,
    outflows,
    reservesFromOperatingCash: opReserve,
    priorDistributions,
    raw,
    availableCash: raw > 0n ? raw : 0n,
  };
}

export function computeUnusedCapital(
  l: CashLedger,
  asOf: IsoDate,
): {
  capitalReceived: Cents;
  loanProceeds: Cents;
  spentFromCapital: Cents;
  reservesFromCapital: Cents;
  returned: Cents;
  loanServiceFromCapital: Cents;
  unusedCapital: Cents;
} {
  const dated = <T extends { on: IsoDate }>(rows: readonly T[]) =>
    rows.filter((r) => onOrBefore(r.on, asOf));
  const capitalReceived = sum(dated(l.capitalReceived), (r) => r.amount);
  const loanProceeds = sum(dated(l.loanProceeds), (r) => r.amount);
  const spentFromCapital = sum(
    dated(l.expenses).filter(
      (e) => e.fundingSource === "CAPITAL_CONTRIBUTIONS",
    ),
    (e) => e.amount,
  );
  const reservesFromCapital = reserveBalances(l.reserves, asOf).capital;
  const returned = sum(
    dated(l.distributions).filter((d) => d.type === "RETURN_OF_UNUSED_CAPITAL"),
    (d) => d.gross,
  );
  const loanServiceFromCapital = sum(
    dated(l.loanPayments).filter(
      (p) => p.fundingSource === "CAPITAL_CONTRIBUTIONS",
    ),
    (p) => p.principal + p.interest,
  );
  const { crossToOperating, crossToCapital } = crossFlows(l.reserves, asOf);
  return {
    capitalReceived,
    loanProceeds,
    spentFromCapital,
    reservesFromCapital,
    returned,
    loanServiceFromCapital,
    unusedCapital:
      capitalReceived +
      loanProceeds -
      spentFromCapital -
      reservesFromCapital -
      returned -
      loanServiceFromCapital -
      crossToOperating +
      crossToCapital,
  };
}

/** R23: organizational and offering expense cap. */
export function orgExpenseCapStatus(i: {
  counted: Cents;
  cap: Cents;
  approvedIncrease: Cents;
  adding?: Cents;
}): { counted: Cents; limit: Cents; remaining: Cents; wouldExceed: boolean } {
  const limit = i.cap + i.approvedIncrease;
  return {
    counted: i.counted,
    limit,
    remaining: limit - i.counted,
    wouldExceed: i.counted + (i.adding ?? 0n) > limit,
  };
}

/** R25: simple interest, actual/365, rounded once over all segments (days = to − from). */
export function loanAccruedInterest(i: {
  principalOutstandingSegments: readonly {
    from: IsoDate;
    to: IsoDate;
    principal: Cents;
  }[];
  bps: number;
}): Cents {
  let numerator = 0n;
  for (const s of i.principalOutstandingSegments) {
    const days = daysBetween(s.from, s.to);
    if (days < 0) {
      throw new LlcMathError(
        "BAD_SEGMENT",
        `Segment ends before it starts: ${s.from}..${s.to}`,
      );
    }
    numerator += s.principal * BigInt(i.bps) * BigInt(days);
  }
  return roundDiv(numerator, 10_000n * 365n);
}
