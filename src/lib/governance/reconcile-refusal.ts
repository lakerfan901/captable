// The P38 refusal of `memberReport.release` (04-investor-portal.md P38, 5.9
// step 4; package P13a). Pure: relative imports only.
//
// Release throws a TRPCError whose `cause` is a `ReconciliationRefusal`; the
// tRPC error formatter copies its `differences` to `error.data.reconciliation`
// so the release dialog can list them (P16), and the message names every
// figure for the toast that shows server refusals today (P4c).

import type { FigureDifference } from "./report-reconcile";

export type { FigureDifference };

/** What `error.data.reconciliation` carries on a P38 refusal (null on every other error). */
export interface ReconciliationErrorData {
  differences: FigureDifference[];
}

export class ReconciliationRefusal extends Error {
  readonly differences: FigureDifference[];
  constructor(differences: readonly FigureDifference[]) {
    super(reconciliationMessage(differences));
    this.name = "ReconciliationRefusal";
    this.differences = differences.map((d) => ({ ...d }));
  }
}

const LABELS: Record<string, string> = {
  "revenue.amountCents": "Gross Revenue",
  "expenses.totalCents": "Total expenses",
  "expenses.lines": "Expenses",
  "managementFee.accruedCents": "Management Fee accrued",
  "managementFee.paidCents": "Management Fee paid",
  "managementFee.unpaidAtEndCents": "Management Fee unpaid at period end",
  "reserves.balanceCents": "Reserve balance",
  "reserves.minimumRequiredCents": "Minimum reserve",
  "distributions.totalCents": "Distributions",
  "distributions.preferredReturnCents": "Distributions: Preferred Return",
  "distributions.returnOfCapitalCents": "Distributions: return of capital",
  "distributions.residualCents": "Distributions: residual",
  "managerPayments.lines": "Payment to the Manager",
  "managerPayments.insiderDistributions": "Insider distribution",
  "managerPayments.insiderLoanPayments.principal":
    "Insider loan payment (principal)",
  "managerPayments.insiderLoanPayments.interest":
    "Insider loan payment (interest)",
  "managerPayments.grandTotalCents":
    "Payments to the Manager and Affiliates, total",
};

/** A readable name of a difference's `field` ("Expenses: COLOCATION"). */
export function figureLabel(field: string): string {
  const bracket = field.indexOf("[");
  if (bracket >= 0 && field.endsWith("]")) {
    const base = field.slice(0, bracket);
    const key = field.slice(bracket + 1, -1);
    return `${LABELS[base] ?? base}: ${key}`;
  }
  return LABELS[field] ?? field;
}

/** Cents as "$1,234.56" ("-$5.00"); null as "none". */
export function centsText(cents: number | null): string {
  if (cents === null) return "none";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${rest}`;
}

const LISTED = 5;

/** The refusal message: every differing figure up to five, then a count. */
export function reconciliationMessage(
  differences: readonly FigureDifference[],
): string {
  const shown = differences
    .slice(0, LISTED)
    .map(
      (d) =>
        `${figureLabel(d.field)} (report ${centsText(d.reportCents)}, ledger ${centsText(d.ledgerCents)})`,
    );
  const more =
    differences.length > LISTED
      ? ` and ${differences.length - LISTED} more`
      : "";
  return `The report figures differ from the ledger for this period: ${shown.join("; ")}${more}. Refresh the figures from the ledger, or correct the ledger, before releasing.`;
}

/** The value of `error.data.reconciliation` for an error cause (null unless it is a P38 refusal). */
export function reconciliationErrorData(
  cause: unknown,
): ReconciliationErrorData | null {
  return cause instanceof ReconciliationRefusal
    ? { differences: cause.differences.map((d) => ({ ...d })) }
    : null;
}
