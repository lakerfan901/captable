import Link from "next/link";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateOnly } from "@/lib/date-only";
import {
  displayUnits,
  type TransferKind,
} from "@/lib/governance/transfer-core";
import type { RouterOutputs } from "@/trpc/shared";

// Unit transfer list (03-governance.md G17) and the labels shared with the
// form and the detail page. Server-safe (no hooks).

export type TransferRow = RouterOutputs["unitTransfer"]["list"][number];

export const TRANSFER_KIND_LABEL: Record<TransferKind, string> = {
  VOLUNTARY: "Voluntary (7.1)",
  PERMITTED_TRANSFEREE: "Permitted Transferee (7.1)",
  INVOLUNTARY: "Involuntary (7.2)",
  DEATH_INCAPACITY: "Death or incapacity (7.3)",
};

export function kindLabel(kind: string): string {
  return TRANSFER_KIND_LABEL[kind as TransferKind] ?? kind;
}

export function classKindLabel(kind: string): string {
  return kind === "COMMON" ? "Common" : "Preferred";
}

/** "50 Preferred Units". */
export function unitsText(units: string, unitClassKind: string): string {
  const n = displayUnits(units);
  return `${n} ${classKindLabel(unitClassKind)} ${n === "1" ? "Unit" : "Units"}`;
}

export const FINANCIAL_INTEREST_ONLY_LABEL =
  "Financial Interest only — not admitted";

export function transferStatusOf(row: {
  status: string;
  admittedOn: string | null;
}): { label: string; variant: NonNullable<BadgeProps["variant"]> } {
  switch (row.status) {
    case "OPEN":
      return { label: "Open", variant: "warning" };
    case "COMPLETED":
      return row.admittedOn === null
        ? { label: FINANCIAL_INTEREST_ONLY_LABEL, variant: "info" }
        : { label: "Completed", variant: "success" };
    case "CANCELLED":
      return { label: "Cancelled", variant: "outline" };
    default:
      return { label: row.status, variant: "secondary" };
  }
}

export function TransferStatusBadge({
  status,
  admittedOn,
}: {
  status: string;
  admittedOn: string | null;
}) {
  const s = transferStatusOf({ status, admittedOn });
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function TransferTable({
  rows,
  base,
}: {
  rows: TransferRow[];
  /** `/<companyPublicId>/transfers` */
  base: string;
}) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date of notice</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>From</TableHead>
            <TableHead>To</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Effective</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.publicId}>
              <TableCell className="whitespace-nowrap">
                <Link className="underline" href={`${base}/${r.publicId}`}>
                  {formatDateOnly(r.noticeReceivedOn)}
                </Link>
              </TableCell>
              <TableCell>{kindLabel(r.kind)}</TableCell>
              <TableCell className="font-medium">{r.fromName}</TableCell>
              <TableCell>
                {r.toName ?? (
                  <span className="text-muted-foreground">Not named</span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums">
                {unitsText(r.units, r.unitClassKind)}
              </TableCell>
              <TableCell>
                <TransferStatusBadge
                  status={r.status}
                  admittedOn={r.admittedOn}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {r.status === "CANCELLED" || r.effectiveOn === null ? (
                  "—"
                ) : r.status === "OPEN" ? (
                  <span className="text-muted-foreground">
                    {formatDateOnly(r.effectiveOn)} if completed
                  </span>
                ) : (
                  formatDateOnly(r.effectiveOn)
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
