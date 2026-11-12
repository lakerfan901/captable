"use client";

import { type ColumnDef, useTable } from "@tanstack/react-table";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table/data-table";
import { DataTableBody } from "@/components/ui/data-table/data-table-body";
import { DataTableContent } from "@/components/ui/data-table/data-table-content";
import { DataTableHeader } from "@/components/ui/data-table/data-table-header";
import { DataTablePagination } from "@/components/ui/data-table/data-table-pagination";
import {
  type DataTableFeatures,
  dataTableFeatures,
} from "@/components/ui/data-table/features";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { trimUnits } from "@/server/llc/serialize";
import type { ReceiptDTO } from "@/trpc/routers/commitment-router/dto";

export type ReceiptRow = ReceiptDTO & { stakeholderName: string };

const KIND_LABELS: Record<ReceiptDTO["kind"], string> = {
  INITIAL: "Initial",
  BALANCE: "Balance",
  REPLACEMENT: "Replacement",
  CREDIT: "Credit",
  FORFEITURE: "Forfeiture",
};

function MemberCell({ row }: { row: ReceiptRow }) {
  const { publicId } = useParams<{ publicId: string }>();
  return (
    <Link
      href={`/${publicId}/stakeholders/${row.stakeholderId}`}
      className="font-medium hover:underline"
    >
      {row.stakeholderName}
    </Link>
  );
}

function ReceiptState({ row }: { row: ReceiptRow }) {
  if (row.voided) return <Badge variant="secondary">Voided</Badge>;
  if (row.appliedOn !== null) return <Badge variant="success">Applied</Badge>;
  return <Badge variant="warning">Held</Badge>;
}

// F7b adds the row menu (Void).
const columns: ColumnDef<DataTableFeatures, ReceiptRow>[] = [
  {
    id: "receivedOn",
    header: "Received",
    cell: ({ row }) => formatDateOnly(row.original.receivedOn),
  },
  {
    id: "member",
    header: "Member",
    cell: ({ row }) => <MemberCell row={row.original} />,
  },
  {
    id: "kind",
    header: "Kind",
    cell: ({ row }) => KIND_LABELS[row.original.kind],
  },
  {
    id: "amount",
    header: "Amount",
    cell: ({ row }) => formatCents(row.original.amountCents),
  },
  {
    id: "applied",
    header: "Applied",
    cell: ({ row }) => formatCents(row.original.appliedCents),
  },
  {
    id: "units",
    header: "Units",
    cell: ({ row }) => trimUnits(row.original.unitsIssued),
  },
  {
    id: "returnStarts",
    header: "Return starts",
    cell: ({ row }) =>
      row.original.prefReturnStartDate
        ? formatDateOnly(row.original.prefReturnStartDate)
        : "—",
  },
  {
    id: "reference",
    header: "Reference",
    cell: ({ row }) => row.original.reference ?? "—",
  },
  {
    id: "state",
    header: "Status",
    cell: ({ row }) => <ReceiptState row={row.original} />,
  },
];

export function ReceiptTable({ receipts }: { receipts: ReceiptRow[] }) {
  const table = useTable({
    features: dataTableFeatures,
    data: receipts,
    columns,
  });

  return (
    <div className="w-full p-6">
      <DataTable table={table}>
        <DataTableContent>
          <DataTableHeader />
          <DataTableBody />
        </DataTableContent>
        <DataTablePagination />
      </DataTable>
    </div>
  );
}
