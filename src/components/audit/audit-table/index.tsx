"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type SortingState,
  useTable,
} from "@tanstack/react-table";
import * as React from "react";
import { dayjsExt } from "@/common/dayjs";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { RouterOutputs } from "@/trpc/shared";
import { AuditTableToolbar } from "./audit-table-toolbar";

type Audit = RouterOutputs["audit"]["getAudits"]["data"];

interface AuditTableProps {
  audits: Audit;
}

export const columns: ColumnDef<DataTableFeatures, Audit[number]>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    id: "action",
    accessorKey: "action",
    header: () => {
      return <div>Action</div>;
    },
    cell: ({ row }) => (
      <div>
        <Badge variant="secondary">{row.getValue("action")}</Badge>
      </div>
    ),
    filterFn: (row, id, value: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return value.includes(row.getValue(id));
    },
  },

  {
    id: "occurredAt",
    accessorKey: "occurredAt",
    header: ({ column }) => {
      return (
        <SortButton
          label="Time"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      );
    },
    cell: ({ row }) => {
      const date = new Date(row.getValue("occurredAt"));
      const formattedDate = dayjsExt(date).format("lll");
      return <time dateTime={date.toISOString()}>{formattedDate}</time>;
    },
  },

  {
    id: "summary",
    accessorKey: "summary",
    header: () => {
      return <div>Summary</div>;
    },
    cell: ({ row }) => {
      return <p>{row.getValue("summary")}</p>;
    },
  },
];

export function AuditTable({ audits }: AuditTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});

  const table = useTable({
    features: dataTableFeatures,
    data: audits,
    columns: columns,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  return (
    <div className="w-full p-6">
      <DataTable table={table}>
        <AuditTableToolbar />
        <DataTableContent>
          <DataTableHeader />
          <DataTableBody />
        </DataTableContent>
        <DataTablePagination />
      </DataTable>
    </div>
  );
}
