"use client";

import Link from "next/link";
import { IsoDateText, Money } from "@/components/llc/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  type Computation,
  LinesTable,
  rowsFromComputation,
} from "./lines-table";
import { TierSummary } from "./tier-summary";

type Issue = Computation["blockers"][number];

/** Where each blocker or warning is fixed: a page of the company (new tab) or a step of this wizard. */
const FIX: Record<
  string,
  { label: string; path?: string; step?: "setup" | "inputs" }
> = {
  MISSING_REVENUE_MONTH: { label: "Fix revenue", path: "financials/revenue" },
  NEGATIVE_RAW_CASH: { label: "Review financials", path: "financials" },
  MIN_RESERVE: { label: "Adjust reserves", path: "financials/reserves" },
  LOAN_PAST_MATURITY: {
    label: "Open member loans",
    path: "financials/loans-advances",
  },
  PERIOD_CLOSED: {
    label: "Open term clock settings",
    path: "settings/llc-term",
  },
  OCD_NOT_SET: { label: "Open term clock settings", path: "settings/llc-term" },
  TERMS_INCOMPLETE: { label: "Open unit classes", path: "unit-classes" },
  NO_UNITS_IN_CLASS: { label: "Open unit classes", path: "unit-classes" },
  HOLDER_WITHOUT_UNITS: { label: "Open members", path: "stakeholders" },
  DEFAULT_EXCESS_HELD: {
    label: "Open defaults",
    path: "capital-calls/defaults",
  },
  OFFSET_DATE_ORDER: { label: "Open defaults", path: "capital-calls/defaults" },
  PENDING_DEFAULT_STEP: {
    label: "Open defaults",
    path: "capital-calls/defaults",
  },
  OVERDUE_UNDECLARED: {
    label: "Open overdue Call Notice lines",
    path: "capital-calls",
  },
  OFFSET_RECEIPT_IN_FUTURE: { label: "Change the payment date", step: "setup" },
  RETURN_EXCEEDS_UNPAID: { label: "Change the payment date", step: "setup" },
  PERIOD_END_NOT_MONTH_END: { label: "Change the period", step: "setup" },
  PAYMENT_BEFORE_PERIOD_END: {
    label: "Change the payment date",
    step: "setup",
  },
  PAYMENT_BEFORE_LEDGER_EVENT: {
    label: "Change the payment date",
    step: "setup",
  },
  PAYMENT_TOO_FAR_AHEAD: { label: "Change the payment date", step: "setup" },
  DEADLINE_PASSED: { label: "Review the setup", step: "setup" },
  RETURN_NOT_PERIOD_END: { label: "Review the setup", step: "setup" },
  AMOUNT_ZERO: { label: "Review the inputs", step: "inputs" },
  EXCEEDS_UNUSED_CAPITAL: { label: "Change the amount", step: "inputs" },
  EXCEEDS_UNRETURNED_CAPITAL: { label: "Change the amount", step: "inputs" },
  INSUFFICIENT_FOR_CREDITORS: {
    label: "Edit the liquidation worksheet",
    step: "inputs",
  },
};

export function IssueList({
  issues,
  tone,
  companyBase,
  stepHref,
}: {
  issues: Issue[];
  tone: "blocker" | "warning";
  companyBase: string;
  stepHref: (step: "setup" | "inputs") => string;
}) {
  if (issues.length === 0) return null;
  const cls =
    tone === "blocker"
      ? "border-red-300 bg-red-50 text-red-900"
      : "border-amber-300 bg-amber-50 text-amber-900";
  return (
    <div className={`rounded-md border p-3 text-sm ${cls}`}>
      <p className="mb-2 font-medium">
        {tone === "blocker"
          ? "Fix these before finalizing"
          : "Check these before finalizing"}
      </p>
      <ul className="flex flex-col gap-2">
        {issues.map((issue) => {
          const fix = FIX[issue.code] ?? {
            label: "Review the setup",
            step: "setup" as const,
          };
          return (
            <li key={`${issue.code}-${issue.message}`}>
              {issue.message}{" "}
              {fix.path ? (
                <Link
                  className="whitespace-nowrap font-medium underline"
                  href={`${companyBase}/${fix.path}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {fix.label}
                </Link>
              ) : (
                <Link
                  className="whitespace-nowrap font-medium underline"
                  href={stepHref(fix.step ?? "setup")}
                >
                  {fix.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function StepReview({
  computation: c,
  companyBase,
  stepHref,
  conflict,
  canFinalize,
  onRecalculate,
  recalculating,
  onContinue,
}: {
  computation: Computation;
  companyBase: string;
  stepHref: (step: "setup" | "inputs") => string;
  conflict: boolean;
  canFinalize: boolean;
  onRecalculate: () => void;
  recalculating: boolean;
  onContinue: () => void;
}) {
  const owedC = c.lines.reduce((s, l) => s + l.unpaidReturnMeasured, 0);
  const owedD = c.lines.reduce((s, l) => s + l.unreturnedBefore, 0);
  const blocked = c.blockers.length > 0;
  return (
    <div className="flex flex-col gap-4">
      {conflict ? (
        <Alert variant="destructive">
          <AlertTitle>The figures changed</AlertTitle>
          <AlertDescription>
            Something was recorded since this review was computed, so the
            distribution was not finalized. The figures below are recomputed;
            review them again before finalizing.
          </AlertDescription>
        </Alert>
      ) : null}

      <IssueList
        issues={c.blockers}
        tone="blocker"
        companyBase={companyBase}
        stepHref={stepHref}
      />
      <IssueList
        issues={c.warnings}
        tone="warning"
        companyBase={companyBase}
        stepHref={stepHref}
      />

      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <p>
          Amount <Money className="font-semibold" cents={c.amount} />, payment
          date <IsoDateText date={c.paymentDate} />. Preferred Return measured
          as of <IsoDateText date={c.returnMeasuredAsOf} />.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRecalculate}
          loading={recalculating}
        >
          Recalculate
        </Button>
      </div>

      <TierSummary
        t={{
          tierC: c.tierC,
          tierD: c.tierD,
          tierEPreferred: c.tierEPreferred,
          tierECommon: c.tierECommon,
          owedC,
          owedD,
        }}
      />

      <LinesTable rows={rowsFromComputation(c.lines)} />

      <div className="flex justify-between">
        <Button variant="outline" asChild>
          <Link href={stepHref("inputs")}>Back</Link>
        </Button>
        {canFinalize ? (
          <Button onClick={onContinue} disabled={blocked}>
            Continue to finalize
          </Button>
        ) : null}
      </div>
    </div>
  );
}
