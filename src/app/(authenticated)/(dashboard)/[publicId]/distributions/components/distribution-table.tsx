import Link from "next/link";
import { IsoDateText, Money } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";

export type DistributionRow =
  RouterOutputs["distribution"]["list"]["rows"][number];
export type DistributionTypeValue = DistributionRow["type"];
export type DistributionStatusValue = DistributionRow["status"];

export const TYPE_LABEL: Record<DistributionTypeValue, string> = {
  OPERATING: "Operating",
  RETURN_OF_UNUSED_CAPITAL: "Return of unused capital",
  SALE_OR_LIQUIDATION: "Sale or liquidation",
};

export function typeLabel(row: {
  type: DistributionTypeValue;
  isLiquidation: boolean;
  isReversal: boolean;
}): string {
  const base =
    row.type === "SALE_OR_LIQUIDATION" && row.isLiquidation
      ? "Liquidation (Section 11.4)"
      : TYPE_LABEL[row.type];
  return row.isReversal ? `Reversal of ${base.toLowerCase()}` : base;
}

export function DistributionStatusBadge({
  status,
  isReversal,
}: {
  status: DistributionStatusValue;
  isReversal: boolean;
}) {
  if (isReversal) return <Badge variant="secondary">Reversal</Badge>;
  if (status === "DRAFT") return <Badge variant="warning">Draft</Badge>;
  if (status === "REVERSED")
    return <Badge variant="destructive">Reversed</Badge>;
  return <Badge variant="success">Finalized</Badge>;
}

/** "Jan 1, 2027 – Mar 31, 2027", or the period end alone. */
export function PeriodText({
  periodStart,
  periodEnd,
}: {
  periodStart: string | null;
  periodEnd: string;
}) {
  return periodStart ? (
    <span>
      <IsoDateText date={periodStart} /> – <IsoDateText date={periodEnd} />
    </span>
  ) : (
    <span>
      through <IsoDateText date={periodEnd} />
    </span>
  );
}

export function DistributionTable({
  rows,
  base,
}: {
  rows: DistributionRow[];
  base: string;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>No.</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Payment date</TableHead>
            <TableHead className="text-right">Gross</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link className="underline" href={`${base}/${r.id}`}>
                  {r.number === null ? "Draft" : `No. ${r.number}`}
                </Link>
              </TableCell>
              <TableCell>{typeLabel(r)}</TableCell>
              <TableCell>
                <PeriodText
                  periodStart={r.periodStart}
                  periodEnd={r.periodEnd}
                />
              </TableCell>
              <TableCell>
                <IsoDateText date={r.paymentDate} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={r.amountCents} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={r.totalNetCents} />
              </TableCell>
              <TableCell>
                <DistributionStatusBadge
                  status={r.status}
                  isReversal={r.isReversal}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
