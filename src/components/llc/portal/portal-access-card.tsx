"use client";

import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAllowed } from "@/hooks/use-allowed";
import { formatInstant } from "@/lib/company-time";
import type { MailDeliveryState } from "@/lib/mail-delivery";
import { accessActions } from "@/lib/portal/access-admin-core";
import { useEntity } from "@/providers/entity-provider";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { InviteDialog } from "./invite-dialog";

type AccessRow = RouterOutputs["portalAdmin"]["accessForHolder"][number];

function AccessStatus({ row }: { row: AccessRow }) {
  if (row.status === "DISABLED") {
    return <Badge variant="secondary">Disabled</Badge>;
  }
  return (
    <>
      {row.status === "ACTIVE" ? (
        <>
          <Badge variant="success">Active</Badge>
          <span className="text-xs text-muted-foreground">Password set</span>
        </>
      ) : (
        <>
          <Badge variant="warning">Invited</Badge>
          <span className="text-xs text-muted-foreground">Not yet set up</span>
        </>
      )}
      {row.locked && <Badge variant="destructive">Locked</Badge>}
    </>
  );
}

function RowActions({
  row,
  onChanged,
}: {
  row: AccessRow;
  onChanged: () => void;
}) {
  const onError = (e: { message: string }) => toast.error(e.message);
  const resend = api.portalAdmin.resendInvite.useMutation({
    onSuccess: (r) => {
      toast.success(`Invitation sent again to ${r.email}.`);
      onChanged();
    },
    onError,
  });
  const status = api.portalAdmin.setAccessStatus.useMutation({
    onSuccess: (r) => {
      toast.success(
        `Access ${r.status === "DISABLED" ? "disabled" : "enabled"} for ${r.email}.`,
      );
      onChanged();
    },
    onError,
  });
  const unlock = api.portalAdmin.unlock.useMutation({
    onSuccess: (r) => {
      toast.success(`Unlocked ${r.email}.`);
      onChanged();
    },
    onError,
  });
  const busy = resend.isPending || status.isPending || unlock.isPending;
  const can = accessActions({
    state: row.status,
    passwordSet: row.passwordSet,
    locked: row.locked,
  });
  const accessId = row.accessId;

  return (
    <div className="flex justify-end gap-1">
      {can.enable && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          loading={status.isPending}
          onClick={() => status.mutate({ accessId, status: "ACTIVE" })}
        >
          Enable
        </Button>
      )}
      {can.resend && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          loading={resend.isPending}
          onClick={() => resend.mutate({ accessId })}
        >
          Resend invitation
        </Button>
      )}
      {can.unlock && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          loading={unlock.isPending}
          onClick={() => unlock.mutate({ accessId })}
        >
          Unlock
        </Button>
      )}
      {can.disable && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          loading={status.isPending}
          onClick={() => status.mutate({ accessId, status: "DISABLED" })}
        >
          Disable
        </Button>
      )}
    </div>
  );
}

/**
 * "Portal access" on the member page's Profile tab (04-investor-portal.md
 * 6.2; package P3). One row per person invited for this holder. The page
 * renders this card only for a role with `portal: read`; the invite button
 * needs `portal: create`, the row actions `portal: update`.
 */
export function PortalAccessCard({
  stakeholderId,
  holderName,
  defaultEmail,
  mailDelivery,
}: {
  stakeholderId: string;
  holderName: string;
  defaultEmail: string;
  mailDelivery: MailDeliveryState;
}) {
  const { timezone } = useEntity();
  const utils = api.useUtils();
  const query = api.portalAdmin.accessForHolder.useQuery({ stakeholderId });
  const { isAllowed: canUpdate } = useAllowed({
    subject: "portal",
    action: "update",
  });
  const refresh = () => {
    void utils.portalAdmin.accessForHolder.invalidate({ stakeholderId });
  };
  const rows = query.data ?? [];

  return (
    <Card id="portal-access-card">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-base">Portal access</CardTitle>
          <CardDescription>
            People who can sign in to the investor portal for {holderName}.
          </CardDescription>
        </div>
        <Allow subject="portal" action="create">
          <InviteDialog
            stakeholderId={stakeholderId}
            holderName={holderName}
            defaultEmail={defaultEmail}
            mailDelivery={mailDelivery}
            onInvited={refresh}
          />
        </Allow>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">{query.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody has been invited for this member yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                  {canUpdate && (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.accessId}>
                    <TableCell className="break-all font-medium">
                      {row.email}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <AccessStatus row={row} />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatInstant(row.lastSeenAt, timezone)}
                    </TableCell>
                    {canUpdate && (
                      <TableCell className="whitespace-nowrap text-right">
                        <RowActions row={row} onChanged={refresh} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
