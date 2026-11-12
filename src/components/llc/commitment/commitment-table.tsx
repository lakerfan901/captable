"use client";

import { RiMore2Fill } from "@remixicon/react";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Allow } from "@/components/rbac/allow";
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
import { diffInDays, formatDateOnly, todayInTimeZone } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useEntity } from "@/providers/entity-provider";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";
import { CommitmentStatusBadge } from "./commitment-status-badge";
import { DecideCommitmentDialog } from "./decide-commitment-dialog";
import { RecordReceiptDialog } from "./record-receipt-dialog";
import { RecordRefundDialog } from "./record-refund-dialog";
import { RejectCommitmentDialog } from "./reject-commitment-dialog";

function MemberCell({ row }: { row: CommitmentDTO }) {
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

function DecideByCell({ row, today }: { row: CommitmentDTO; today: string }) {
  const date = row.effectiveDecisionDeadline;
  if (row.status !== "PENDING" || date === null) return <>—</>;
  const daysLeft = diffInDays(today, date);
  return (
    <span
      className={cn(
        row.decisionOverdue && "font-medium text-red-600",
        !row.decisionOverdue && daysLeft <= 3 && "text-amber-600",
      )}
    >
      {formatDateOnly(date)}
    </span>
  );
}

function RefundDueCell({ row, today }: { row: CommitmentDTO; today: string }) {
  if (row.refundOutstandingCents <= 0) return <>—</>;
  const late = row.refundDueBy !== null && today > row.refundDueBy;
  return (
    <span className={cn(late && "font-medium text-red-600")}>
      {formatCents(row.refundOutstandingCents)}
      {row.refundDueBy ? ` by ${formatDateOnly(row.refundDueBy)}` : ""}
    </span>
  );
}

function RowActions({
  row,
  unitClass,
  acceptedTotalCents,
}: {
  row: CommitmentDTO;
  unitClass: UnitClassDTO | null;
  acceptedTotalCents: number;
}) {
  const { publicId } = useParams<{ publicId: string }>();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [decideOpen, setDecideOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const canRecord = row.status !== "REJECTED";
  const canDecide = row.status === "PENDING";
  const canRefund = row.refundOutstandingCents > 0;
  // A pending commitment has acceptedCents 0, so the class total is the rest.
  const otherAcceptedCents = acceptedTotalCents - row.acceptedCents;

  if (!canRecord && !canRefund && !row.packetPublicId) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0">
            <span className="sr-only">Open menu</span>
            <RiMore2Fill className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRecord ? (
            <Allow action="create" subject="commitments">
              <DropdownMenuItem onSelect={() => setReceiptOpen(true)}>
                Record receipt
              </DropdownMenuItem>
            </Allow>
          ) : null}
          {canDecide ? (
            <Allow action="update" subject="commitments">
              <DropdownMenuItem onSelect={() => setDecideOpen(true)}>
                Accept or reduce
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRejectOpen(true)}>
                Reject
              </DropdownMenuItem>
            </Allow>
          ) : null}
          {canRefund ? (
            <Allow action="update" subject="commitments">
              <DropdownMenuItem onSelect={() => setRefundOpen(true)}>
                Record refund
              </DropdownMenuItem>
            </Allow>
          ) : null}
          {row.packetPublicId ? (
            <DropdownMenuItem asChild>
              <Link href={`/${publicId}/admissions/${row.packetPublicId}`}>
                Open packet
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {canRecord ? (
        <RecordReceiptDialog
          commitment={row}
          unitClass={unitClass}
          open={receiptOpen}
          onOpenChange={setReceiptOpen}
        />
      ) : null}
      {canDecide ? (
        <>
          <DecideCommitmentDialog
            commitment={row}
            unitClass={unitClass}
            otherAcceptedCents={otherAcceptedCents}
            open={decideOpen}
            onOpenChange={setDecideOpen}
          />
          <RejectCommitmentDialog
            commitment={row}
            unitClass={unitClass}
            open={rejectOpen}
            onOpenChange={setRejectOpen}
          />
        </>
      ) : null}
      {canRefund ? (
        <RecordRefundDialog
          commitment={row}
          open={refundOpen}
          onOpenChange={setRefundOpen}
        />
      ) : null}
    </>
  );
}

export function CommitmentTable({
  commitments,
  unitClass,
  acceptedTotalCents,
}: {
  commitments: CommitmentDTO[];
  /** The PREFERRED class (receipt and decision previews); null when missing. */
  unitClass: UnitClassDTO | null;
  /** Σ acceptedCents of the class's ACCEPTED/REDUCED commitments (cap check). */
  acceptedTotalCents: number;
}) {
  const { timezone } = useEntity();
  const today = todayInTimeZone(timezone);
  const columns = useMemo<ColumnDef<DataTableFeatures, CommitmentDTO>[]>(
    () => [
      {
        id: "member",
        header: "Member",
        cell: ({ row }) => <MemberCell row={row.original} />,
      },
      {
        id: "committed",
        header: "Committed",
        cell: ({ row }) => formatCents(row.original.committedCents),
      },
      {
        id: "accepted",
        header: "Accepted",
        cell: ({ row }) =>
          row.original.status === "PENDING"
            ? "—"
            : formatCents(row.original.acceptedCents),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <CommitmentStatusBadge status={row.original.status} />
        ),
      },
      {
        id: "received",
        header: "Received",
        cell: ({ row }) =>
          formatCents(
            row.original.receipts
              .filter((r) => !r.voided)
              .reduce((sum, r) => sum + r.amountCents, 0),
          ),
      },
      {
        id: "applied",
        header: "Applied",
        cell: ({ row }) => formatCents(row.original.capitalCents),
      },
      {
        id: "balance",
        header: "Balance",
        cell: ({ row }) =>
          row.original.status === "PENDING" ||
          row.original.status === "REJECTED"
            ? "—"
            : formatCents(row.original.outstandingBalanceCents),
      },
      {
        id: "decideBy",
        header: "Decide by",
        cell: ({ row }) => <DecideByCell row={row.original} today={today} />,
      },
      {
        id: "refundDue",
        header: "Refund due",
        cell: ({ row }) => <RefundDueCell row={row.original} today={today} />,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActions
            row={row.original}
            unitClass={unitClass}
            acceptedTotalCents={acceptedTotalCents}
          />
        ),
      },
    ],
    [unitClass, today, acceptedTotalCents],
  );

  const table = useTable({
    features: dataTableFeatures,
    data: commitments,
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
