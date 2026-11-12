import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";
import { UnitClassFormDialog } from "./unit-class-form-dialog";

const bpsToPercent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const money = (cents: number | null) =>
  cents === null ? "Not set" : formatCents(cents);
const date = (d: string | null) => (d === null ? "Not set" : formatDateOnly(d));
const units = (u: string | null) => (u === null ? "Not limited" : u);

const RETURN_START_LABELS: Record<
  UnitClassDTO["balanceReturnStartRule"],
  string
> = {
  LATER_OF_RECEIPT_AND_DUE: "Later of receipt and due date",
  RECEIPT_DATE: "Receipt date",
};

export function UnitClassCard({ unitClass }: { unitClass: UnitClassDTO }) {
  const c = unitClass;
  const terms: [string, string][] = [
    ["Kind", c.kind === "PREFERRED" ? "Preferred" : "Common"],
    ["Price per unit", money(c.pricePerUnitCents)],
    ["Authorized units", units(c.authorizedUnits)],
    ["Issued units", c.issuedUnits],
    ["Fractional units allowed", c.fractionalUnitsAllowed ? "Yes" : "No"],
    ["Votes per unit", c.votesPerUnit],
    ["Preferred Return rate", bpsToPercent(c.prefReturnBps)],
    ["Day count", "Actual/365"],
    ["Balance return start", RETURN_START_LABELS[c.balanceReturnStartRule]],
    ["Residual split", bpsToPercent(c.residualSplitBps)],
  ];
  if (c.kind === "PREFERRED") {
    terms.push(
      ["Minimum commitment", money(c.minCommitmentCents)],
      ["Minimum waiver floor", money(c.minCommitmentFloorCents)],
      ["Offering cap", money(c.offeringCapCents)],
      ["Initial installment", bpsToPercent(c.initialInstallmentBps)],
      ["Final Closing Date", date(c.finalClosingDate)],
      ["Balance outside date", date(c.balanceOutsideDate)],
      ["Acceptance window", `${c.acceptanceBusinessDays} business days`],
      ["Refund window", `${c.refundBusinessDays} business days`],
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h4 className="font-medium">{c.name}</h4>
          {c.termsLocked && <Badge variant="secondary">Terms locked</Badge>}
        </div>
        <Allow subject="unit-classes" action="update">
          <UnitClassFormDialog unitClass={c} />
        </Allow>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {terms.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
