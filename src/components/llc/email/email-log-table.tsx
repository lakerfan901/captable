"use client";

import { RiMore2Fill } from "@remixicon/react";
import { type ColumnDef, useTable } from "@tanstack/react-table";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table/data-table";
import { DataTableBody } from "@/components/ui/data-table/data-table-body";
import { DataTableContent } from "@/components/ui/data-table/data-table-content";
import { DataTableHeader } from "@/components/ui/data-table/data-table-header";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/trpc/react";
import type { EmailLogDTO } from "@/trpc/routers/email-log-router/schema";
import { MarkBounceDialog } from "./mark-bounce-dialog";

const PAGE_SIZE = 50;

type EmailLogPage = { items: EmailLogDTO[]; nextCursor: string | null };

type EmailLogTableProps = {
  /** First page rendered by the server (page) or undefined (member tab). */
  initialData?: EmailLogPage;
  stakeholderId?: string;
  emptyText?: string;
};

const formatLocal = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "";

function StatusBadge({ email }: { email: EmailLogDTO }) {
  if (email.status === "SENT") {
    return <Badge variant="success">Sent</Badge>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant="destructive">Failed</Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        {email.errorMessage ?? "Unknown error"}
      </TooltipContent>
    </Tooltip>
  );
}

function BounceBadge({ email }: { email: EmailLogDTO }) {
  if (email.bounceState === "NONE") return null;
  const label = email.bounceState === "BOUNCED" ? "Bounced" : "Complained";
  const badge = <Badge variant="warning">{label}</Badge>;
  if (!email.bounceNote && !email.bouncedAt) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        {email.bouncedAt ? `Recorded ${formatLocal(email.bouncedAt)}. ` : ""}
        {email.bounceNote ?? ""}
      </TooltipContent>
    </Tooltip>
  );
}

function RowActions({
  email,
  onUpdated,
}: {
  email: EmailLogDTO;
  onUpdated: (email: EmailLogDTO) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const clear = api.emailLog.markBounce.useMutation({
    onSuccess: (updated) => {
      toast.success("Bounce cleared.");
      onUpdated(updated);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  return (
    <Allow action="update" subject="emails">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0">
            <span className="sr-only">Open menu</span>
            <RiMore2Fill className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {email.bounceState === "NONE" ? (
            <DropdownMenuItem onSelect={() => setOpen(true)}>
              Mark as bounced
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={clear.isPending}
              onSelect={() =>
                clear.mutate({ id: email.id, bounceState: "NONE" })
              }
            >
              Clear bounce
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <MarkBounceDialog
        email={email}
        open={open}
        onOpenChange={setOpen}
        onUpdated={onUpdated}
      />
    </Allow>
  );
}

export function EmailLogTable({
  initialData,
  stakeholderId,
  emptyText = "No emails have been sent yet.",
}: EmailLogTableProps) {
  const params = useParams<{ publicId: string }>();
  const utils = api.useUtils();
  const input = { take: PAGE_SIZE, stakeholderId };

  const firstPage = api.emailLog.list.useQuery(input, { initialData });
  const [morePages, setMorePages] = useState<EmailLogPage[]>([]);
  const [overrides, setOverrides] = useState<Record<string, EmailLogDTO>>({});
  const [loadingMore, setLoadingMore] = useState(false);

  const pages = useMemo(
    () => (firstPage.data ? [firstPage.data, ...morePages] : []),
    [firstPage.data, morePages],
  );
  const items = useMemo(() => {
    const seen = new Set<string>();
    const all: EmailLogDTO[] = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(overrides[item.id] ?? item);
      }
    }
    return all;
  }, [pages, overrides]);
  const nextCursor = pages.length
    ? (pages[pages.length - 1]?.nextCursor ?? null)
    : null;

  const onUpdated = useCallback((email: EmailLogDTO) => {
    setOverrides((prev) => ({ ...prev, [email.id]: email }));
  }, []);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await utils.emailLog.list.fetch({
        ...input,
        cursor: nextCursor,
      });
      setMorePages((prev) => [...prev, page]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not load more emails.",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const columns = useMemo<ColumnDef<DataTableFeatures, EmailLogDTO>[]>(
    () => [
      {
        id: "sentAt",
        header: "Sent",
        cell: ({ row }) => (
          <div className="whitespace-nowrap">
            {formatLocal(row.original.sentAt ?? row.original.createdAt)}
          </div>
        ),
      },
      {
        id: "to",
        header: "To",
        cell: ({ row }) => <div>{row.original.toAddress}</div>,
      },
      {
        id: "member",
        header: "Member",
        cell: ({ row }) =>
          row.original.stakeholderId ? (
            <Link
              className="underline-offset-4 hover:underline"
              href={`/${params.publicId}/stakeholders/${row.original.stakeholderId}`}
            >
              {row.original.stakeholderName ?? "Member"}
            </Link>
          ) : null,
      },
      {
        id: "subject",
        header: "Subject",
        cell: ({ row }) => (
          <div className="font-medium">{row.original.subject}</div>
        ),
      },
      {
        id: "kind",
        header: "Type",
        cell: ({ row }) => <code className="text-xs">{row.original.kind}</code>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge email={row.original} />,
      },
      {
        id: "bounce",
        header: "Bounce",
        cell: ({ row }) => <BounceBadge email={row.original} />,
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <RowActions email={row.original} onUpdated={onUpdated} />
        ),
      },
    ],
    [params.publicId, onUpdated],
  );

  const table = useTable({
    features: dataTableFeatures,
    data: items,
    columns,
  });

  if (firstPage.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  if (firstPage.error) {
    return (
      <p className="p-6 text-sm text-destructive">{firstPage.error.message}</p>
    );
  }

  if (items.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <TooltipProvider>
      <div className="w-full p-6">
        <DataTable table={table}>
          <DataTableContent>
            <DataTableHeader />
            <DataTableBody />
          </DataTableContent>
        </DataTable>
        {nextCursor ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
