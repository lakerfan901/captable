"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

type Line = RouterOutputs["callNotice"]["get"]["lines"][number];

/**
 * Warnings and actions for lines whose send did not finish cleanly:
 * - SENT/PAID lines whose prepaid money was not matched → "Re-match prepaid money";
 * - lines left in SENDING for more than two minutes → "Resolve" (the email
 *   log shows the email was accepted) or "Mark as sent" / "Mark as not sent".
 */
export function SendResolution({
  lines,
  canUpdate,
}: {
  lines: Line[];
  canUpdate: boolean;
}) {
  const unmatched = lines.filter((l) => !l.prepaidMatched);
  const sending = lines.filter((l) => l.status === "SENDING");
  const stale = sending.filter((l) => l.sendingStale);
  const failedButLogged = lines.filter(
    (l) => l.status === "SEND_FAILED" && l.sentEmailLog !== null,
  );
  if (
    unmatched.length === 0 &&
    sending.length === 0 &&
    failedButLogged.length === 0
  ) {
    return null;
  }
  return (
    <div className="grid gap-3">
      {sending.length > stale.length ? (
        <Alert>
          <AlertTitle>Sending</AlertTitle>
          <AlertDescription>
            {sending.length - stale.length} email(s) are being sent. Refresh the
            page in a moment.
          </AlertDescription>
        </Alert>
      ) : null}
      {stale.length + failedButLogged.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Send not finished — review each line</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p>
              The send of these lines started more than two minutes ago and was
              not recorded. They are never changed automatically. Do not send
              them again until resolved: the email may have been delivered.
            </p>
            <ul className="grid gap-2">
              {[...stale, ...failedButLogged].map((l) => (
                <li
                  key={l.lineId}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="font-medium">{l.name}</span>
                  {l.sentEmailLog ? (
                    <span>
                      The email log shows the email to{" "}
                      {l.sentEmailLog.toAddress} was accepted.
                    </span>
                  ) : (
                    <span>No email log row shows the email was accepted.</span>
                  )}
                  {canUpdate ? <ResolveActions line={l} /> : null}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {unmatched.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Prepaid money not yet matched</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p>
              Money already received from{" "}
              {unmatched.map((l) => l.name).join(", ")} has not been matched to
              the line sent to them (recording the send was interrupted). It is
              matched automatically before their next payment is recorded.
            </p>
            {canUpdate ? <RematchButton /> : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function RematchButton() {
  const router = useRouter();
  const mutation = api.callNotice.reconcile.useMutation();
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        loading={mutation.isPending}
        disabled={mutation.isPending}
        onClick={async () => {
          try {
            const r = await mutation.mutateAsync({});
            toast.success(
              `Prepaid money matched for ${r.lines.length} line(s).`,
            );
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Re-match prepaid money
      </Button>
    </div>
  );
}

function ResolveActions({ line }: { line: Line }) {
  const router = useRouter();
  const mutation = api.callNotice.resolveSending.useMutation();
  const [open, setOpen] = useState(false);
  const [sentOn, setSentOn] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async (
    action: "RESOLVE" | "MARK_SENT" | "MARK_NOT_SENT",
    date?: string,
  ) => {
    setError(null);
    try {
      await mutation.mutateAsync({
        lineId: line.lineId,
        action,
        sentOn: date,
      });
      toast.success(
        action === "MARK_NOT_SENT"
          ? `${line.name}: marked as not sent; it can be sent again.`
          : `${line.name}: recorded as sent.`,
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(message);
    }
  };

  if (line.sentEmailLog) {
    return (
      <Button
        size="sm"
        variant="outline"
        loading={mutation.isPending}
        disabled={mutation.isPending}
        onClick={() => run("RESOLVE")}
      >
        Resolve
      </Button>
    );
  }
  return (
    <span className="flex gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            Mark as sent
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark the notice to {line.name} as sent</DialogTitle>
            <DialogDescription>
              Only if you know the email reached the member (for example, it is
              in the sent mail of the mail provider). The due date is computed
              from the date you enter and is never earlier than the one printed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`sent-on-${line.lineId}`}>Date it was sent</Label>
            <Input
              id={`sent-on-${line.lineId}`}
              type="date"
              value={sentOn}
              onChange={(e) => setSentOn(e.target.value)}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              loading={mutation.isPending}
              disabled={mutation.isPending || sentOn === ""}
              onClick={() => run("MARK_SENT", sentOn)}
            >
              Mark as sent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button
        size="sm"
        variant="outline"
        loading={mutation.isPending}
        disabled={mutation.isPending}
        onClick={() => run("MARK_NOT_SENT")}
      >
        Mark as not sent
      </Button>
    </span>
  );
}
