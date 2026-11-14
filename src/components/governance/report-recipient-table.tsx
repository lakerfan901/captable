"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { formatInstant } from "@/lib/company-time";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

// Recipients of a sent member report (03-governance.md G13): delivery state
// from the email log, link state, views, and the Resend / Replace link
// actions (only with `governance: update`; the server checks regardless).

type Recipient = RouterOutputs["memberReport"]["get"]["recipients"][number];

function DeliveryState({ r }: { r: Recipient }) {
  switch (r.emailState) {
    case "FAILED":
    case "BOUNCED":
      return (
        <span className="font-medium text-red-600">
          Not delivered{r.emailState === "BOUNCED" ? " (bounced)" : ""}
        </span>
      );
    case "SENT":
      return <span>Sent</span>;
    default:
      return <span className="text-muted-foreground">Queued</span>;
  }
}

function LinkState({ r }: { r: Recipient }) {
  if (r.linkState === "ACTIVE") return null;
  return (
    <Badge variant="outline" className="ml-2">
      {r.linkState === "EXPIRED" ? "Link expired" : "Link replaced"}
    </Badge>
  );
}

function ReplaceLinkDialog({
  recipient,
  publicId,
  onClose,
}: {
  recipient: Recipient;
  publicId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const replace = api.memberReport.replaceLink.useMutation();
  const submit = async () => {
    try {
      const trimmed = email.trim();
      await replace.mutateAsync({
        publicId,
        recipientId: recipient.id,
        ...(trimmed ? { email: trimmed } : {}),
      });
      toast.success(
        `A new link is being emailed to ${trimmed || recipient.email}.`,
      );
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not replace link.");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace the link of {recipient.name}</DialogTitle>
          <DialogDescription>
            A new link to the report is emailed. Leave the email empty to use{" "}
            {recipient.email}.
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertDescription>
            The previous link stops working immediately.
          </AlertDescription>
        </Alert>
        <div className="space-y-1">
          <Label htmlFor="report-replace-email">New email (optional)</Label>
          <Input
            id="report-replace-email"
            type="email"
            value={email}
            maxLength={320}
            placeholder={recipient.email}
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

export function ReportRecipientTable({
  publicId,
  recipients,
  timeZone,
  canUpdate,
}: {
  publicId: string;
  recipients: Recipient[];
  timeZone: string;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const resend = api.memberReport.resend.useMutation();
  const [replacing, setReplacing] = useState<Recipient | null>(null);

  const doResend = async (recipientId?: string) => {
    try {
      const res = await resend.mutateAsync({
        publicId,
        ...(recipientId ? { recipientId } : {}),
      });
      toast.success(
        `${res.queued} ${res.queued === 1 ? "email" : "emails"} queued.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resend.");
    }
  };

  return (
    <div className="space-y-3">
      {canUpdate ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={resend.isPending}
            onClick={() => void doResend()}
          >
            Resend to all
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Delivery</TableHead>
              <TableHead>First viewed</TableHead>
              <TableHead>Views</TableHead>
              {canUpdate ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {recipients.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.name}
                  <LinkState r={r} />
                </TableCell>
                <TableCell className="break-all">{r.email}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstant(r.lastEmailAt ?? r.sentAt, timeZone)}
                </TableCell>
                <TableCell>
                  <DeliveryState r={r} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstant(r.firstViewedAt, timeZone)}
                </TableCell>
                <TableCell className="tabular-nums">{r.viewCount}</TableCell>
                {canUpdate ? (
                  <TableCell className="whitespace-nowrap text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resend.isPending || r.linkState === "REVOKED"}
                      onClick={() => void doResend(r.id)}
                    >
                      Resend
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReplacing(r)}
                    >
                      Replace link
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {replacing ? (
        <ReplaceLinkDialog
          recipient={replacing}
          publicId={publicId}
          onClose={() => setReplacing(null)}
        />
      ) : null}
    </div>
  );
}
