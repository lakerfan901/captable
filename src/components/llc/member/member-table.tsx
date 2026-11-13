"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import Link from "next/link";
import { useParams } from "next/navigation";
import React from "react";
import { DataTable } from "@/components/ui/data-table/data-table";
import { DataTableBody } from "@/components/ui/data-table/data-table-body";
import { SortButton } from "@/components/ui/data-table/data-table-buttons";
import { DataTableContent } from "@/components/ui/data-table/data-table-content";
import { DataTableHeader } from "@/components/ui/data-table/data-table-header";
import { DataTablePagination } from "@/components/ui/data-table/data-table-pagination";
import {
  type DataTableFeatures,
  dataTableFeatures,
} from "@/components/ui/data-table/features";
import { formatDateOnly } from "@/lib/date-only";
import type { RouterOutputs } from "@/trpc/shared";
import {
  HOLDER_TYPE_LABELS,
  InsiderBadge,
  MemberStatusBadge,
} from "./member-profile-card";

type Stakeholders = RouterOutputs["stakeholder"]["getStakeholders"];
type Row = Stakeholders[number];

function NameCell({ row }: { row: Row }) {
  const { publicId } = useParams<{ publicId: string }>();
  return (
    <Link
      href={`/${publicId}/stakeholders/${row.id}`}
      className="font-medium hover:underline"
    >
      {row.name}
    </Link>
  );
}

const columns: ColumnDef<DataTableFeatures, Row>[] = [
  {
    id: "name",
    header: ({ column }) => (
      <SortButton
        label="Name"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      />
    ),
    accessorFn: (row) => row.name,
    cell: ({ row }) => <NameCell row={row.original} />,
  },
  {
    id: "type",
    header: "Type",
    cell: ({ row }) =>
      row.original.holderType
        ? HOLDER_TYPE_LABELS[row.original.holderType]
        : "—",
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <MemberStatusBadge
        status={row.original.memberStatus}
        committed={row.original.hasPendingCommitment}
      />
    ),
  },
  {
    id: "admitted",
    header: "Admitted",
    cell: ({ row }) =>
      row.original.admittedOn
        ? formatDateOnly(row.original.admittedOn.toISOString().slice(0, 10))
        : "—",
  },
  {
    id: "noticeEmail",
    header: "Notice email",
    cell: ({ row }) => row.original.noticeEmail ?? row.original.email,
  },
  {
    id: "insider",
    header: "Insider",
    cell: ({ row }) => (row.original.isInsider ? <InsiderBadge /> : null),
  },
];

export function MemberTable({ stakeholders }: { stakeholders: Stakeholders }) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<ColumnVisibilityState>({});

  const table = useTable({
    features: dataTableFeatures,
    data: stakeholders,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    state: { sorting, columnFilters, columnVisibility },
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
