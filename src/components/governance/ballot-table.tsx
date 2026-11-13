"use client";

import { RiMore2Fill } from "@remixicon/react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/trpc/react";
import {
  formatInstant,
  formatUnits,
  type ResolutionGetOutput,
} from "./tally-panel";

// Ballots of a sent resolution (03-governance.md G11) for the Manager user:
// who was asked, link and delivery state, and each recorded response with its
// signature evidence.

export type BallotRow = ResolutionGetOutput["ballots"][number];
export type EmailRow = ResolutionGetOutput["emails"][number];

export const NOT_DELIVERED_TOOLTIP =
  "An email notice is not effective if a non-delivery notice is received (Section 13.6)";

export function isNotDelivered(e: Pick<EmailRow, "status" | "bounceState">) {
  return e.status === "FAILED" || e.bounceState === "BOUNCED";
}

/** Latest log of `kind` per stakeholder (`emails` is newest first). */
export function latestEmailBy(
  emails: readonly EmailRow[],
  kind: string,
): Map<string, EmailRow> {
  const out = new Map<string, EmailRow>();
  for (const e of emails) {
    if (e.kind !== kind || e.stakeholderId === null) continue;
    if (!out.has(e.stakeholderId)) out.set(e.stakeholderId, e);
  }
  return out;
}

export function DeliveryState({ email }: { email: EmailRow | undefined }) {
  if (!email) return <span className="text-muted-foreground">—</span>;
  if (isNotDelivered(email)) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help font-medium text-red-600">
              Not delivered
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {NOT_DELIVERED_TOOLTIP}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return <span>Sent</span>;
}

export function responseLabel(b: {
  choice: string | null;
  deemed: boolean;
}): string {
  if (b.choice === null) return "—";
  if (b.deemed) return "Deemed against";
  if (b.choice === "FOR") return "For";
  if (b.choice === "AGAINST") return "Against";
  if (b.choice === "ABSTAIN") return "Abstain";
  return b.choice;
}

function linkLabel(b: BallotRow): string {
  if (b.linkState === "REVOKED") return "Revoked";
  if (b.linkState === "EXPIRED") return "Expired";
  return b.tokenVersion > 1 ? `Replaced v${b.tokenVersion}` : "Active";
}

function CountsFor({ b }: { b: BallotRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {b.countsPreferred ? <Badge variant="secondary">Preferred</Badge> : null}
      {b.countsDisinterested ? (
        <Badge variant="secondary">Disinterested</Badge>
      ) : null}
      {!b.countsPreferred && !b.countsDisinterested ? (
        <Badge variant="outline">Consent only</Badge>
      ) : null}
    </div>
  );
}

function ReplaceLinkDialog({
  ballot,
  publicId,
  onClose,
  onDone,
}: {
  ballot: BallotRow;
  publicId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const replace = api.resolution.replaceBallotLink.useMutation();
  const submit = async () => {
    try {
      const trimmed = email.trim();
      const res = await replace.mutateAsync({
        publicId,
        ballotId: ballot.id,
        ...(trimmed ? { email: trimmed } : {}),
      });
      toast.success(
        `A new link (version ${res.tokenVersion}) is being emailed to ${trimmed || ballot.email}.`,
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not replace link.");
    } finally {
      onDone();
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace the link of {ballot.name}</DialogTitle>
          <DialogDescription>
            A new ballot link is emailed to the Member. Leave the email empty to
            use {ballot.email}.
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertDescription>
            The previous link stops working immediately
          </AlertDescription>
        </Alert>
        <div className="space-y-1">
          <Label htmlFor="replace-email">New email (optional)</Label>
          <Input
            id="replace-email"
            type="email"
            value={email}
            maxLength={320}
            placeholder={ballot.email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={replace.isPending} onClick={() => void submit()}>
            {replace.isPending ? "Replacing…" : "Replace link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeLinkDialog({
  ballot,
  publicId,
  onClose,
  onDone,
}: {
  ballot: BallotRow;
  publicId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const revoke = api.resolution.revokeBallotLink.useMutation();
  const submit = async () => {
    try {
      await revoke.mutateAsync({ publicId, ballotId: ballot.id });
      toast.success(`The link of ${ballot.name} was revoked.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not revoke link.");
    } finally {
      onDone();
    }
  };
  return (
    <AlertDialog open onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke the link of {ballot.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The link stops working immediately and the Member can no longer
            respond with it. Their units stay in the denominator. You can
            replace the link later to let them respond.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            Revoke link
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BallotTable({
  publicId,
  ballots,
  emails,
  open,
  canUpdate,
  timeZone,
  onChanged,
}: {
  publicId: string;
  ballots: BallotRow[];
  emails: EmailRow[];
  /** The resolution is SENT and its window has not passed. */
  open: boolean;
  canUpdate: boolean;
  timeZone: string;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<{
    kind: "replace" | "revoke";
    ballot: BallotRow;
  } | null>(null);
  const remind = api.resolution.remind.useMutation();
  const delivery = latestEmailBy(emails, "resolution.ballot");

  const remindOne = async (b: BallotRow) => {
    try {
      const res = await remind.mutateAsync({ publicId, ballotIds: [b.id] });
      if (res.sent > 0)
        toast.success(`A reminder is being emailed to ${b.name}.`);
      else
        toast.info(
          "No reminder sent: the Member has responded, the link is revoked, or a reminder went out in the last 24 hours.",
        );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send reminder.");
    } finally {
      onChanged();
    }
  };

  if (ballots.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        No ballots were issued for this resolution.
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead className="text-right">Preferred Units</TableHead>
            <TableHead>Counts for</TableHead>
            <TableHead>Link</TableHead>
            <TableHead>Email delivery</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Viewed</TableHead>
            <TableHead>Response</TableHead>
            <TableHead>Signed by</TableHead>
            <TableHead>Responded at</TableHead>
            <TableHead>IP address</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ballots.map((b) => {
            const actionable = open && canUpdate && b.submittedAt === null;
            return (
              <TableRow key={b.id}>
                <TableCell className="font-medium">{b.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {b.email}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUnits(b.preferredUnits)}
                </TableCell>
                <TableCell>
                  <CountsFor b={b} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {linkLabel(b)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <DeliveryState email={delivery.get(b.stakeholderId)} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstant(b.invitedAt, timeZone)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {b.firstViewedAt
                    ? `${formatInstant(b.firstViewedAt, timeZone)}${b.viewCount > 1 ? ` (${b.viewCount}×)` : ""}`
                    : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {responseLabel(b)}
                </TableCell>
                <TableCell>
                  {b.signedName
                    ? `${b.signedName}${b.signerCapacity ? `, ${b.signerCapacity}` : ""}`
                    : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstant(b.submittedAt, timeZone)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {b.submitIp ?? "—"}
                </TableCell>
                <TableCell>
                  {actionable ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Actions for ${b.name}`}
                        >
                          <RiMore2Fill className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={b.linkState !== "ACTIVE"}
                          onSelect={() => void remindOne(b)}
                        >
                          Remind
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            setDialog({ kind: "replace", ballot: b })
                          }
                        >
                          Replace link
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={b.linkState === "REVOKED"}
                          onSelect={() =>
                            setDialog({ kind: "revoke", ballot: b })
                          }
                        >
                          Revoke link
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {dialog?.kind === "replace" ? (
        <ReplaceLinkDialog
          ballot={dialog.ballot}
          publicId={publicId}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
      {dialog?.kind === "revoke" ? (
        <RevokeLinkDialog
          ballot={dialog.ballot}
          publicId={publicId}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
    </Card>
  );
}
