"use client";

import { RiMore2Fill } from "@remixicon/react";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table/data-table";
import { DataTableBody } from "@/components/ui/data-table/data-table-body";
import { DataTableContent } from "@/components/ui/data-table/data-table-content";
import { DataTableHeader } from "@/components/ui/data-table/data-table-header";
import { DataTablePagination } from "@/components/ui/data-table/data-table-pagination";
import {
  type DataTableFeatures,
  dataTableFeatures,
} from "@/components/ui/data-table/features";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { trimUnits } from "@/server/llc/serialize";
import type { ReceiptDTO } from "@/trpc/routers/commitment-router/dto";
import { VoidReceiptDialog } from "./void-receipt-dialog";

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

function ReceiptActions({ row }: { row: ReceiptRow }) {
  const [voidOpen, setVoidOpen] = useState(false);
  if (row.voided) return null;
  return (
    <Allow action="delete" subject="commitments">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0">
            <span className="sr-only">Open menu</span>
            <RiMore2Fill className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setVoidOpen(true)}>
            Void
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <VoidReceiptDialog
        receipt={row}
        stakeholderName={row.stakeholderName}
        open={voidOpen}
        onOpenChange={setVoidOpen}
      />
    </Allow>
  );
}

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
  {
    id: "actions",
    header: "",
    cell: ({ row }) => <ReceiptActions row={row.original} />,
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
