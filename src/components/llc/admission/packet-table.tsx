"use client";

import { RiMore2Fill } from "@remixicon/react";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAllowed } from "@/hooks/use-allowed";
import type { PacketStage } from "@/lib/admission/packet-stage";
import { useEntity } from "@/providers/entity-provider";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { PacketStageBadge } from "./packet-stage-badge";

// Sent Exhibit B packets (01-foundation.md F12). Button rules follow the
// server: cancel only while the investor has not signed, or after signing
// while no commitment exists yet; resend only while the investor has not
// signed. Review opens the Manager confirmation page (F13) once there is
// something to review.

export type PacketRow = RouterOutputs["admission"]["list"][number];

const REVIEW_STAGES: readonly PacketStage[] = [
  "AWAITING_REVIEW",
  "AWAITING_COUNTERSIGN",
];

export function canCancelPacket(row: PacketRow): boolean {
  return (
    row.stage === "AWAITING_INVESTOR" ||
    (row.stage === "AWAITING_REVIEW" && row.commitmentId === null)
  );
}

export function canResendPacket(row: PacketRow): boolean {
  return row.stage === "AWAITING_INVESTOR";
}

function formatSent(at: Date | string, timeZone: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
  }).format(d);
}

function InvestorCell({
  row,
  companyPublicId,
}: {
  row: PacketRow;
  companyPublicId: string;
}) {
  const name = row.stakeholderName ?? "—";
  if (!row.stakeholderId) return <span className="font-medium">{name}</span>;
  return (
    <Link
      href={`/${companyPublicId}/stakeholders/${row.stakeholderId}`}
      className="font-medium hover:underline"
    >
      {name}
    </Link>
  );
}

function CancelPacketDialog({
  row,
  open,
  onOpenChange,
}: {
  row: PacketRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { mutate, isPending } = api.admission.cancel.useMutation({
    onSuccess: () => {
      toast.success("Subscription cancelled.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel subscription</DialogTitle>
          <DialogDescription>
            The signing link sent to {row.stakeholderName ?? "the investor"}{" "}
            stops working. This cannot be undone; send a new subscription if
            needed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button
            variant="destructive"
            loading={isPending}
            onClick={() => mutate({ publicId: row.publicId })}
          >
            Cancel subscription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowActions({
  row,
  companyPublicId,
  mailBlocked,
}: {
  row: PacketRow;
  companyPublicId: string;
  mailBlocked: boolean;
}) {
  const router = useRouter();
  const [cancelOpen, setCancelOpen] = useState(false);
  const { isAllowed: canUpdate } = useAllowed({
    action: "update",
    subject: "commitments",
  });
  const resend = api.admission.resend.useMutation({
    onSuccess: () => {
      toast.success("Signing email sent again.");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const showReview = REVIEW_STAGES.includes(row.stage);
  const showResend = canUpdate && canResendPacket(row);
  const showCancel = canUpdate && canCancelPacket(row);
  if (!showReview && !showResend && !showCancel) return null;

  return (
    <div className="flex items-center justify-end gap-2">
      {showReview ? (
        <Button asChild size="sm" variant="outline">
          <Link href={`/${companyPublicId}/admissions/${row.publicId}`}>
            Review
          </Link>
        </Button>
      ) : null}
      {showResend || showCancel ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">Open menu</span>
              <RiMore2Fill className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showResend ? (
              <DropdownMenuItem
                disabled={mailBlocked || resend.isPending}
                onSelect={() => resend.mutate({ publicId: row.publicId })}
              >
                Resend signing email
              </DropdownMenuItem>
            ) : null}
            {showCancel ? (
              <DropdownMenuItem onSelect={() => setCancelOpen(true)}>
                Cancel subscription
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {showCancel ? (
        <CancelPacketDialog
          row={row}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
        />
      ) : null}
    </div>
  );
}

export function PacketTable({
  packets,
  companyPublicId,
  mailBlocked,
}: {
  packets: PacketRow[];
  companyPublicId: string;
  /** Production email is not configured: resending would be refused. */
  mailBlocked: boolean;
}) {
  const { timezone } = useEntity();
  const columns = useMemo<ColumnDef<DataTableFeatures, PacketRow>[]>(
    () => [
      {
        id: "investor",
        header: "Investor",
        cell: ({ row }) => (
          <InvestorCell row={row.original} companyPublicId={companyPublicId} />
        ),
      },
      {
        id: "email",
        header: "Email",
        cell: ({ row }) => row.original.investorEmail ?? "—",
      },
      {
        id: "stage",
        header: "Stage",
        cell: ({ row }) => <PacketStageBadge stage={row.original.stage} />,
      },
      {
        id: "w9",
        header: "W-9",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.w9Count}</span>
        ),
      },
      {
        id: "sent",
        header: "Sent",
        cell: ({ row }) => formatSent(row.original.createdAt, timezone),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActions
            row={row.original}
            companyPublicId={companyPublicId}
            mailBlocked={mailBlocked}
          />
        ),
      },
    ],
    [companyPublicId, mailBlocked, timezone],
  );

  const table = useTable({
    features: dataTableFeatures,
    data: packets,
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
