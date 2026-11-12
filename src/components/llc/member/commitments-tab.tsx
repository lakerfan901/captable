import { CommitmentTable } from "@/components/llc/commitment/commitment-table";
import { ReceiptTable } from "@/components/llc/commitment/receipt-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import { formatCents } from "@/lib/money";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { trimUnits } from "@/server/llc/serialize";
import { api } from "@/trpc/server";

function isActive(status: string): boolean {
  return status === "ACCEPTED" || status === "REDUCED";
}

export async function CommitmentsTab({
  stakeholderId,
}: {
  stakeholderId: string;
}) {
  const { allow } = await serverAccessControl();
  const data = await allow(
    Promise.all([
      api.commitment.list({ stakeholderId }),
      api.commitment.receipts({ stakeholderId }),
      api.unitClass.list(),
      // Class totals for the cap check in the accept dialog.
      api.commitment.list({}),
    ]),
    ["commitments", "read"],
  );

  if (!data) {
    return (
      <Alert>
        <AlertDescription>
          You do not have access to commitments.
        </AlertDescription>
      </Alert>
    );
  }

  const [commitments, receipts, { classes }, all] = data;
  const preferred = classes.find((c) => c.kind === "PREFERRED") ?? null;
  const acceptedTotalCents = all
    .filter((c) => c.unitClassId === preferred?.id && isActive(c.status))
    .reduce((sum, c) => sum + c.acceptedCents, 0);

  if (commitments.length === 0) {
    return (
      <Alert>
        <AlertDescription>
          No commitments yet. Create one on the Commitments page or send a
          subscription from Admissions.
        </AlertDescription>
      </Alert>
    );
  }

  const active = commitments.filter((c) => isActive(c.status));
  const committed = active.reduce((sum, c) => sum + c.acceptedCents, 0);
  const pending = commitments
    .filter((c) => c.status === "PENDING")
    .reduce((sum, c) => sum + c.committedCents, 0);
  const paid = commitments.reduce((sum, c) => sum + c.cashAppliedCents, 0);
  const balance = active.reduce((sum, c) => sum + c.outstandingBalanceCents, 0);
  const units = trimUnits(
    microUnitsToDecimalString(
      commitments.reduce((sum, c) => sum + microUnitsFromDecimal(c.units), 0n),
    ),
  );

  const summary = [
    {
      label: "Committed",
      value:
        pending > 0
          ? `${formatCents(committed)} (+${formatCents(pending)} pending)`
          : formatCents(committed),
    },
    { label: "Paid", value: formatCents(paid) },
    { label: "Units", value: units },
    { label: "Balance", value: formatCents(balance) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        {summary.map((item) => (
          <div key={item.label}>
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="font-medium tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      <Card>
        <CommitmentTable
          commitments={commitments}
          unitClass={preferred}
          acceptedTotalCents={acceptedTotalCents}
        />
      </Card>
      <Card>
        <ReceiptTable receipts={receipts} />
      </Card>
    </div>
  );
}
