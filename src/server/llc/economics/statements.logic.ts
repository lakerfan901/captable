// Member statement and fair value (02-economics.md E18, R43). Pure, relative
// imports only (tested without the `@/` alias).

import { compareIso, type IsoDate } from "../../../lib/llc/dates";
import {
  type Cents,
  LlcMathError,
  type MicroUnits,
  roundDiv,
} from "../../../lib/llc/money";
import type { HolderPosition } from "../../../lib/llc/positions";
import { pctString } from "../../../lib/llc/units";
import {
  fairValueOfUnits,
  hypotheticalLiquidation,
  type WaterfallHolder,
  type WaterfallLine,
} from "../../../lib/llc/waterfall";

// ---------------------------------------------------------------------------
// Member statement

export interface StatementBalances {
  contributed: Cents;
  unreturned: Cents;
  preferredUnits: MicroUnits;
  commonUnits: MicroUnits;
  /** pctString of the Preferred class */
  preferredPct: string;
  accruedReturn: Cents;
  unpaidReturn: Cents;
}

export type StatementActivityKind =
  | "CONTRIBUTION"
  | "CREDIT"
  | "REPLACEMENT"
  | "FORFEITURE"
  | "DISTRIBUTION"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "TAX_ADVANCE";

export interface StatementActivity {
  on: IsoDate;
  kind: StatementActivityKind;
  description: string;
  amount: Cents;
  units: MicroUnits | null;
  refId: string;
}

export interface StatementPeriod {
  contributions: Cents;
  credits: Cents;
  forfeited: Cents;
  returnAccrued: Cents;
  returnPaid: Cents;
  returnExtinguished: Cents;
  capitalReturned: Cents;
  residualPaid: Cents;
  grossDistributions: Cents;
  defaultOffsets: Cents;
  taxAdvanceOffsets: Cents;
  netPaid: Cents;
}

export interface StatementCommitment {
  committed: Cents;
  paid: Cents;
  uncalled: Cents;
  calledOutstanding: Cents;
}

export interface StatementDefault {
  memberDefaultId: string;
  status: string;
  outstandingBalance: Cents;
  interestOwed: Cents;
  costsOwed: Cents;
}

export interface MemberStatement {
  stakeholderId: string;
  name: string;
  from: IsoDate;
  to: IsoDate;
  /** positions as of addDays(from, −1) */
  opening: StatementBalances;
  /** positions as of to */
  closing: StatementBalances;
  period: StatementPeriod;
  activity: StatementActivity[];
  commitment: StatementCommitment | null;
  defaults: StatementDefault[];
  taxAdvanceOutstanding: Cents;
}

/**
 * A member default as the statement shows it AS OF `asOf` (the statement's
 * `to`, E18 "closing … as of to"): null when it was not yet in effect (due
 * date not passed, R32 `dueOn < asOf`) or is VOIDED; a default cured after
 * `asOf` was still OPEN then.
 */
export function defaultStatusAsOf(
  d: { status: string; dueOn: IsoDate; curedOn: IsoDate | null },
  asOf: IsoDate,
): "OPEN" | "CURED" | null {
  if (d.status === "VOIDED") return null;
  if (compareIso(d.dueOn, asOf) >= 0) return null;
  if (d.status !== "CURED") return "OPEN";
  // A cure without a date is shown as cured (as the stored status says).
  return d.curedOn !== null && compareIso(d.curedOn, asOf) > 0
    ? "OPEN"
    : "CURED";
}

/** A Preferred-class CapitalReceipt of the member (non-void, applied). */
export interface StatementReceiptRow {
  id: string;
  kind: "INITIAL" | "BALANCE" | "REPLACEMENT" | "CREDIT" | "FORFEITURE";
  /** appliedOn; receivedOn for FORFEITURE (as the ledger dates them) */
  on: IsoDate;
  /** appliedCents (negative for FORFEITURE) */
  amount: Cents;
  /** unitsIssued (negative for FORFEITURE) */
  units: MicroUnits;
  /** The date the money was received (wire date); defaults to `on`. */
  receivedOn?: IsoDate;
  /** prefReturnStartDate: where this receipt's Preferred Return accrual starts. */
  accrualStartOn?: IsoDate | null;
}

/**
 * The activity line of a receipt. The row is dated as the ledger dates it
 * (`on` = appliedOn: capital and Units exist from then). Money wired before
 * the commitment was accepted is received earlier than that, and an Initial
 * Installment or Replacement funding accrues Preferred Return from the
 * receipt date (02-economics.md "receipts", FOUNDATION Q3): both dates are
 * then stated so the row does not read as a contribution on the wrong day.
 * A Balance receipt's accrual can start per Call Notice allocation, so no
 * single accrual date is printed for it.
 */
export function receiptDescription(r: StatementReceiptRow): string {
  const label = RECEIPT_LABEL[r.kind];
  const cash =
    r.kind === "INITIAL" || r.kind === "BALANCE" || r.kind === "REPLACEMENT";
  if (!cash || r.receivedOn === undefined || r.receivedOn === r.on) {
    return label;
  }
  const parts = [
    `received ${r.receivedOn}`,
    `capital and Units from ${r.on} (acceptance)`,
  ];
  if (
    r.kind !== "BALANCE" &&
    r.accrualStartOn !== undefined &&
    r.accrualStartOn !== null
  ) {
    parts.push(`Preferred Return accrues from ${r.accrualStartOn}`);
  }
  return `${label} (${parts.join("; ")})`;
}

/** The member's line of a FINALIZED, non-reversal distribution. */
export interface StatementDistributionRow {
  distributionId: string;
  number: number;
  type: string;
  paymentDate: IsoDate;
  tierC: Cents;
  tierD: Cents;
  tierEPreferred: Cents;
  tierECommon: Cents;
  gross: Cents;
  /** balance + interest + costs offsets */
  defaultOffset: Cents;
  taxAdvanceOffset: Cents;
  net: Cents;
}

export interface StatementTransferRow {
  id: string;
  on: IsoDate;
  direction: "IN" | "OUT";
  counterparty: string;
  units: MicroUnits;
}

export interface StatementAdvanceRow {
  id: string;
  on: IsoDate;
  kind: string;
  amount: Cents;
}

export function statementBalances(
  p: HolderPosition | undefined,
  commonUnits: MicroUnits,
  totalPreferredUnits: MicroUnits,
): StatementBalances {
  const preferredUnits = p?.preferredUnits ?? 0n;
  return {
    contributed: p?.contributed ?? 0n,
    unreturned: p?.unreturned ?? 0n,
    preferredUnits,
    commonUnits,
    preferredPct: pctString(preferredUnits, totalPreferredUnits),
    accruedReturn: p?.accruedReturn ?? 0n,
    unpaidReturn: p?.unpaidReturn ?? 0n,
  };
}

function inRange(on: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return compareIso(on, from) >= 0 && compareIso(on, to) <= 0;
}

const KIND_ORDER: Record<StatementActivityKind, number> = {
  CONTRIBUTION: 0,
  REPLACEMENT: 1,
  CREDIT: 2,
  FORFEITURE: 3,
  TRANSFER_IN: 4,
  TRANSFER_OUT: 5,
  DISTRIBUTION: 6,
  TAX_ADVANCE: 7,
};

const RECEIPT_LABEL: Record<StatementReceiptRow["kind"], string> = {
  INITIAL: "Initial Installment",
  BALANCE: "Balance payment",
  REPLACEMENT: "Replacement funding",
  CREDIT: "Credit for a forfeited contribution (§4.9(iv))",
  FORFEITURE: "Forfeiture (§4.9(iv))",
};

const ADVANCE_LABEL: Record<string, string> = {
  TAX_WITHHOLDING: "Tax withholding",
  COMPOSITE_RETURN: "Composite return",
  ENTITY_LEVEL_TAX: "Entity-level tax",
  IMPUTED_UNDERPAYMENT: "Imputed underpayment",
};

const ZERO_POSITION: Pick<
  HolderPosition,
  | "accruedReturn"
  | "returnPaid"
  | "returnExtinguished"
  | "returnCarriedIn"
  | "returnCarriedOut"
  | "capitalReturned"
  | "forfeited"
> = {
  accruedReturn: 0n,
  returnPaid: 0n,
  returnExtinguished: 0n,
  returnCarriedIn: 0n,
  returnCarriedOut: 0n,
  capitalReturned: 0n,
  forfeited: 0n,
};

/**
 * Builds the statement from positions as of `addDays(from, −1)` and `to` and
 * the member's rows (rows outside [from, to] are ignored). Throws
 * `STATEMENT_IDENTITY` unless
 * opening.unpaid + accrued − paid − extinguished ± carry = closing.unpaid.
 */
export function buildMemberStatement(i: {
  stakeholderId: string;
  name: string;
  from: IsoDate;
  to: IsoDate;
  openingPosition: HolderPosition | undefined;
  closingPosition: HolderPosition | undefined;
  openingCommonUnits: MicroUnits;
  closingCommonUnits: MicroUnits;
  openingTotalPreferredUnits: MicroUnits;
  closingTotalPreferredUnits: MicroUnits;
  receipts: readonly StatementReceiptRow[];
  distributions: readonly StatementDistributionRow[];
  transfers: readonly StatementTransferRow[];
  advances: readonly StatementAdvanceRow[];
  commitment: StatementCommitment | null;
  defaults: readonly StatementDefault[];
  taxAdvanceOutstanding: Cents;
}): MemberStatement {
  if (compareIso(i.from, i.to) > 0) {
    throw new LlcMathError(
      "BAD_RANGE",
      "The start date is after the end date.",
    );
  }
  const opening = statementBalances(
    i.openingPosition,
    i.openingCommonUnits,
    i.openingTotalPreferredUnits,
  );
  const closing = statementBalances(
    i.closingPosition,
    i.closingCommonUnits,
    i.closingTotalPreferredUnits,
  );
  const o = i.openingPosition ?? ZERO_POSITION;
  const c = i.closingPosition ?? ZERO_POSITION;

  const receipts = i.receipts.filter((r) => inRange(r.on, i.from, i.to));
  const distributions = i.distributions.filter((d) =>
    inRange(d.paymentDate, i.from, i.to),
  );
  const transfers = i.transfers.filter((t) => inRange(t.on, i.from, i.to));
  const advances = i.advances.filter((a) => inRange(a.on, i.from, i.to));

  const sum = <T>(rows: readonly T[], pick: (r: T) => bigint): bigint =>
    rows.reduce((s, r) => s + pick(r), 0n);

  const period: StatementPeriod = {
    contributions: sum(
      receipts.filter(
        (r) =>
          r.kind === "INITIAL" ||
          r.kind === "BALANCE" ||
          r.kind === "REPLACEMENT",
      ),
      (r) => r.amount,
    ),
    credits: sum(
      receipts.filter((r) => r.kind === "CREDIT"),
      (r) => r.amount,
    ),
    forfeited: c.forfeited - o.forfeited,
    returnAccrued: c.accruedReturn - o.accruedReturn,
    returnPaid: c.returnPaid - o.returnPaid,
    returnExtinguished: c.returnExtinguished - o.returnExtinguished,
    capitalReturned: c.capitalReturned - o.capitalReturned,
    residualPaid: sum(distributions, (d) => d.tierEPreferred + d.tierECommon),
    grossDistributions: sum(distributions, (d) => d.gross),
    defaultOffsets: sum(distributions, (d) => d.defaultOffset),
    taxAdvanceOffsets: sum(distributions, (d) => d.taxAdvanceOffset),
    netPaid: sum(distributions, (d) => d.net),
  };

  const carry =
    c.returnCarriedIn -
    c.returnCarriedOut -
    (o.returnCarriedIn - o.returnCarriedOut);
  const expectedUnpaid =
    opening.unpaidReturn +
    period.returnAccrued -
    period.returnPaid -
    period.returnExtinguished +
    carry;
  if (expectedUnpaid !== closing.unpaidReturn) {
    throw new LlcMathError(
      "STATEMENT_IDENTITY",
      `Unpaid Preferred Return does not reconcile: expected ${expectedUnpaid}, closing ${closing.unpaidReturn}`,
    );
  }

  const activity: StatementActivity[] = [];
  for (const r of receipts) {
    activity.push({
      on: r.on,
      kind:
        r.kind === "INITIAL" || r.kind === "BALANCE" ? "CONTRIBUTION" : r.kind,
      description: receiptDescription(r),
      amount: r.amount,
      units: r.units,
      refId: r.id,
    });
  }
  for (const d of distributions) {
    activity.push({
      on: d.paymentDate,
      kind: "DISTRIBUTION",
      description: `Distribution #${d.number}`,
      amount: d.gross,
      units: null,
      refId: d.distributionId,
    });
  }
  for (const t of transfers) {
    activity.push({
      on: t.on,
      kind: t.direction === "IN" ? "TRANSFER_IN" : "TRANSFER_OUT",
      description:
        t.direction === "IN"
          ? `Units transferred from ${t.counterparty}`
          : `Units transferred to ${t.counterparty}`,
      amount: 0n,
      units: t.direction === "IN" ? t.units : -t.units,
      refId: t.id,
    });
  }
  for (const a of advances) {
    activity.push({
      on: a.on,
      kind: "TAX_ADVANCE",
      description: ADVANCE_LABEL[a.kind] ?? "Tax advance",
      amount: a.amount,
      units: null,
      refId: a.id,
    });
  }
  activity.sort(
    (a, b) =>
      compareIso(a.on, b.on) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0),
  );

  return {
    stakeholderId: i.stakeholderId,
    name: i.name,
    from: i.from,
    to: i.to,
    opening,
    closing,
    period,
    activity,
    commitment: i.commitment,
    defaults: [...i.defaults],
    taxAdvanceOutstanding: i.taxAdvanceOutstanding,
  };
}

// ---------------------------------------------------------------------------
// Fair value (R43)

export type FairValueUnitClass = "PREFERRED" | "COMMON";

export interface FairValueLine extends WaterfallLine {
  name: string;
  preferredUnits: MicroUnits;
  commonUnits: MicroUnits;
  /** (tierC + tierD + tierEPreferred) per Preferred Unit; null without Preferred Units */
  perPreferredUnit: Cents | null;
}

export interface FairValueSelected {
  stakeholderId: string;
  unitClass: FairValueUnitClass;
  classGross: Cents;
  unitsHeld: MicroUnits;
  unitsValued: MicroUnits;
  fairValue: Cents;
}

export interface FairValueResult {
  netToMembers: Cents;
  tiers: {
    amount: Cents;
    tierC: Cents;
    tierD: Cents;
    tierEPreferred: Cents;
    tierECommon: Cents;
  };
  lines: FairValueLine[];
  selected: FairValueSelected | null;
}

/** Gross attributable to the Preferred Units of a line (never tierECommon). */
export function preferredGross(line: WaterfallLine): Cents {
  return line.tierC + line.tierD + line.tierEPreferred;
}

/** roundDiv(preferred gross × 10^6, preferredUnits) — value of one whole Preferred Unit. */
export function perPreferredUnit(
  line: WaterfallLine,
  preferredUnits: MicroUnits,
): Cents | null {
  if (preferredUnits <= 0n) return null;
  return roundDiv(preferredGross(line) * 1_000_000n, preferredUnits);
}

/** §11.4 liquidation payoff of member loans: principal + interest accrued and not yet paid. */
export function memberLoansOwed(
  loans: readonly {
    principalOutstanding: Cents;
    accruedInterest: Cents;
    interestPaid: Cents;
  }[],
): Cents {
  let total = 0n;
  for (const l of loans) {
    const principal = l.principalOutstanding > 0n ? l.principalOutstanding : 0n;
    const interest = l.accruedInterest - l.interestPaid;
    total += principal + (interest > 0n ? interest : 0n);
  }
  return total;
}

/**
 * `hypotheticalLiquidation` plus per-member lines and, optionally, the value of
 * `unitsValued` of one member's units of one class (R43). The class defaults
 * to the only class the member holds; `unitsValued` defaults to all of them.
 */
export function computeFairValue(i: {
  assetFmv: Cents;
  cashOnHand: Cents;
  liabilities: Cents;
  memberLoans: Cents;
  holders: readonly WaterfallHolder[];
  residualPreferredBps: number;
  names: ReadonlyMap<string, string>;
  selection: {
    stakeholderId: string;
    unitClass?: FairValueUnitClass;
    unitsValued?: MicroUnits;
  } | null;
}): FairValueResult {
  const { netToMembers, waterfall } = hypotheticalLiquidation(i);
  const byId = new Map(i.holders.map((h) => [h.holderId, h]));
  const lines: FairValueLine[] = waterfall.lines.map((line) => {
    const h = byId.get(line.holderId);
    const preferredUnits = h?.preferredUnits ?? 0n;
    return {
      ...line,
      name: i.names.get(line.holderId) ?? line.holderId,
      preferredUnits,
      commonUnits: h?.commonUnits ?? 0n,
      perPreferredUnit: perPreferredUnit(line, preferredUnits),
    };
  });

  let selected: FairValueSelected | null = null;
  if (i.selection) {
    const s = i.selection;
    const line = lines.find((l) => l.holderId === s.stakeholderId);
    if (!line || (line.preferredUnits <= 0n && line.commonUnits <= 0n)) {
      throw new LlcMathError(
        "NO_UNITS_HELD",
        "The member holds no Units to value.",
      );
    }
    let unitClass = s.unitClass;
    if (!unitClass) {
      if (line.preferredUnits > 0n && line.commonUnits > 0n) {
        throw new LlcMathError(
          "UNIT_CLASS_REQUIRED",
          "The member holds Preferred and Common Units: choose the class to value.",
        );
      }
      unitClass = line.preferredUnits > 0n ? "PREFERRED" : "COMMON";
    }
    const classGross =
      unitClass === "PREFERRED" ? preferredGross(line) : line.tierECommon;
    const unitsHeld =
      unitClass === "PREFERRED" ? line.preferredUnits : line.commonUnits;
    if (unitsHeld <= 0n) {
      throw new LlcMathError(
        "NO_UNITS_HELD",
        `The member holds no ${unitClass === "PREFERRED" ? "Preferred" : "Common"} Units.`,
      );
    }
    const unitsValued = s.unitsValued ?? unitsHeld;
    selected = {
      stakeholderId: s.stakeholderId,
      unitClass,
      classGross,
      unitsHeld,
      unitsValued,
      fairValue: fairValueOfUnits(classGross, unitsValued, unitsHeld),
    };
  }

  return {
    netToMembers,
    tiers: {
      amount: waterfall.amount,
      tierC: waterfall.tierC,
      tierD: waterfall.tierD,
      tierEPreferred: waterfall.tierEPreferred,
      tierECommon: waterfall.tierECommon,
    },
    lines,
    selected,
  };
}
