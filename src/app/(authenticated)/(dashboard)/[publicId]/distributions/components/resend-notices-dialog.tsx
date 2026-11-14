"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { type MailDeliveryState, TEST_MODE_TEXT } from "@/lib/mail-delivery";
import { api } from "@/trpc/react";

export type SentNoticeLine = {
  id: string;
  name: string;
  /** The member's notice address now (where a re-send goes); null when none. */
  noticeAddress: string | null;
  noticeSentAt: Date | string;
  noticeSendCount: number;
  noticeLastSentAt: Date | string | null;
};

const WHEN = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function when(d: Date | string): string {
  return WHEN.format(new Date(d));
}

/**
 * Re-sends sent distribution notices (a bounced or corrected address) to the
 * members' current notice addresses. The server builds the same notice from
 * the stored line; nothing economic changes. Each line carries the notice
 * count shown here, so a double click (or a stale page) sends once.
 */
export function ResendNoticesDialog({
  distributionId,
  distributionNumber,
  lines,
  mailDelivery,
  onDone,
}: {
  distributionId: string;
  distributionNumber: number | null;
  lines: SentNoticeLine[];
  mailDelivery: MailDeliveryState;
  onDone: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const mutation = api.distribution.resendNotices.useMutation();

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const chosen = lines.filter((l) => selected.has(l.id));
  const n = chosen.length;

  const submit = async () => {
    try {
      const { results } = await mutation.mutateAsync({
        id: distributionId,
        lines: chosen.map((l) => ({
          lineId: l.id,
          sendCount: l.noticeSendCount,
        })),
      });
      const sent = results.filter((r) => r.status === "SENT");
      const other = results.filter((r) => r.status !== "SENT");
      if (other.length > 0) {
        toast.error(
          `${sent.length} re-sent. ${other
            .map((r) => `${r.name}: ${r.reason ?? r.status}`)
            .join(" ")}`,
        );
      } else {
        toast.success(`${sent.length} notice(s) re-sent.`);
      }
      setOpen(false);
      setSelected(new Set());
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSelected(new Set());
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">Re-send notices</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Re-send notices of Distribution No. {distributionNumber}
          </DialogTitle>
          <DialogDescription>
            For a notice that bounced or went to a wrong address: correct the
            member's notice email first, then re-send. The same notice (same
            amounts) goes to the address shown; the first notice stays on
            record.
          </DialogDescription>
        </DialogHeader>

        {mailDelivery.blockedReason ? (
          <Alert variant="destructive">
            <AlertTitle>Sending is blocked</AlertTitle>
            <AlertDescription>{mailDelivery.blockedReason}</AlertDescription>
          </Alert>
        ) : mailDelivery.testMode ? (
          <Alert variant="destructive">
            <AlertTitle>Test mode</AlertTitle>
            <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSelected(
                n === lines.length
                  ? new Set()
                  : new Set(lines.map((l) => l.id)),
              )
            }
          >
            {n === lines.length ? "Clear" : "Select all"}
          </Button>
        </div>
        <ul className="max-h-72 space-y-2 overflow-y-auto rounded border p-2 text-sm">
          {lines.map((l) => (
            <li key={l.id} className="flex items-start gap-2">
              <Checkbox
                id={`resend-${l.id}`}
                checked={selected.has(l.id)}
                onCheckedChange={(v) => toggle(l.id, v === true)}
                disabled={l.noticeAddress === null}
                className="mt-0.5"
              />
              <Label htmlFor={`resend-${l.id}`} className="flex-1 font-normal">
                <span className="font-medium">{l.name}</span>
                <span className="block text-muted-foreground">
                  {l.noticeAddress ?? "No email address on file"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Sent {when(l.noticeSentAt)}
                  {l.noticeLastSentAt
                    ? ` · last re-sent ${when(l.noticeLastSentAt)} (${l.noticeSendCount} notice emails in all)`
                    : ""}
                </span>
              </Label>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              n === 0 ||
              mutation.isPending ||
              mailDelivery.blockedReason !== null
            }
            loading={mutation.isPending}
          >
            Re-send to {n} {n === 1 ? "member" : "members"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
