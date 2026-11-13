import { IsoDateText, Money } from "@/components/llc/money";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/trpc/shared";

/** `computeAvailableCash` result on the wire (cents as numbers). */
export type AvailableCashStatement =
  RouterOutputs["llcFinancials"]["summary"]["availableCash"];

function Line({
  label,
  cents,
  sign,
  strong,
  hint,
}: {
  label: string;
  cents: number;
  sign?: "+" | "−";
  strong?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-1",
        strong && "border-t pt-2 font-semibold",
      )}
    >
      <span>
        {sign ? (
          <span className="mr-2 inline-block w-3 text-muted-foreground">
            {sign}
          </span>
        ) : null}
        {label}
        {hint ? (
          <span className="block pl-5 text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
      <Money cents={cents} />
    </div>
  );
}

/**
 * The R20 Available Cash statement (Section 1.15), line by line: inflows,
 * outflows, reserves from operating cash, prior distributions, raw, Available
 * Cash. Read-only; no hooks, usable from server and client components.
 */
export function AvailableCashCard({
  availableCash: a,
  className,
}: {
  availableCash: AvailableCashStatement;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Available Cash</CardTitle>
        <CardDescription>
          Cumulative through <IsoDateText date={a.asOf} /> (Section 1.15).
          Revenue counts once its month is complete. Capital Contributions are
          not Available Cash.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Inflows
        </div>
        <Line
          sign="+"
          label="Gross Revenue"
          hint="Customer receipts less pass-through fees"
          cents={a.inflows.grossRevenue}
        />
        <Line
          sign="+"
          label="Interest and other income"
          cents={a.inflows.otherIncome}
        />
        <Line
          sign="+"
          label="Asset-sale proceeds"
          cents={a.inflows.assetSaleProceeds}
        />
        <Line
          sign="+"
          label="Insurance and casualty proceeds"
          cents={a.inflows.insuranceProceeds}
        />
        <Line
          sign="+"
          label="Default interest and costs collected"
          cents={a.inflows.defaultIncome}
        />
        <Line
          sign="+"
          label="Capital-funded reserves released to operating cash"
          cents={a.inflows.crossToOperating}
        />
        <div className="mt-3 text-xs font-medium uppercase text-muted-foreground">
          Outflows
        </div>
        <Line
          sign="−"
          label="Expenses paid from operating cash"
          cents={a.outflows.operatingExpenses}
        />
        <Line
          sign="−"
          label="Management Fee accrued"
          cents={a.outflows.managementFee}
        />
        <Line
          sign="−"
          label="Member-loan principal and interest paid from operating cash"
          cents={a.outflows.loanService}
        />
        <Line
          sign="−"
          label="Operating reserves released to capital"
          cents={a.outflows.crossToCapital}
        />
        <Line
          sign="−"
          label="Reserves held from operating cash"
          cents={a.reservesFromOperatingCash}
        />
        <Line
          sign="−"
          label="Prior operating and sale distributions"
          cents={a.priorDistributions}
        />
        <Line strong label="Result" cents={a.raw} />
        <Line
          strong
          label="Available Cash"
          hint={
            a.raw < 0
              ? "A negative result is shown as zero and carries forward."
              : undefined
          }
          cents={a.availableCash}
        />
      </CardContent>
    </Card>
  );
}
