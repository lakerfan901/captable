"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

type SendResult = RouterOutputs["callNotice"]["send"]["results"][number];

export type Recipient = {
  lineId: string;
  name: string;
  email: string | null;
  amountCalled: number;
  failed: boolean;
};

/**
 * Lines a "Retry failed" may send again: only those now SEND_FAILED (their
 * email was never accepted). A line with `emailSent: true` was legally sent,
 * and a line left SENDING is resolved on the notice page; re-sending either
 * would issue a second notice.
 */
export function retryableLineIds(results: readonly SendResult[]): string[] {
  return results
    .filter((r) => r.status === "SEND_FAILED" && !r.emailSent)
    .map((r) => r.lineId);
}

export function SendDialog({
  noticeId,
  noticeNumber,
  proposedDueOn,
  sendBlockedReason,
  mailCatcher,
  noticeTerms,
  recipients,
}: {
  noticeId: string;
  noticeNumber: number;
  proposedDueOn: string | null;
  sendBlockedReason: string | null;
  mailCatcher: boolean;
  /** The settings-dependent wording of the notice (default interest, cure period). */
  noticeTerms: { defaultInterestRate: string; curePeriod: string };
  recipients: Recipient[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [sentDueOn, setSentDueOn] = useState<string | null>(null);
  const mutation = api.callNotice.send.useMutation();
  const byLine = new Map(recipients.map((r) => [r.lineId, r]));
  const [names, setNames] = useState(byLine);

  const missingEmail = recipients.filter((r) => r.email === null);
  const blocked =
    sendBlockedReason ??
    (proposedDueOn === null
      ? "The Balance outside date has passed; Call Notices can no longer be sent."
      : missingEmail.length > 0
        ? `No email address on Exhibit A for ${missingEmail.map((r) => r.name).join(", ")}.`
        : null);
  const confirmed = typed.trim() === String(noticeNumber);

  const run = async (lineIds?: string[]) => {
    if (proposedDueOn === null) return;
    setError(null);
    try {
      const r = await mutation.mutateAsync({
        id: noticeId,
        expectedDueOn: proposedDueOn,
        lineIds,
      });
      setNames(new Map([...names, ...byLine]));
      setResults((prev) => {
        if (!prev) return r.results;
        const next = new Map(prev.map((p) => [p.lineId, p]));
        for (const x of r.results) next.set(x.lineId, x);
        return [...next.values()];
      });
      setSentDueOn(r.dueOn);
      const ok = r.results.filter((x) => x.ok).length;
      const failed = r.results.length - ok;
      if (failed === 0) toast.success(`Call Notice sent to ${ok} member(s).`);
      else toast.error(`${failed} of ${r.results.length} could not be sent.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      router.refresh();
    }
  };

  const retry = results ? retryableLineIds(results) : [];
  if (!open && recipients.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setError(null);
          setResults(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>Send</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send Call Notice No. {noticeNumber}</DialogTitle>
          <DialogDescription>
            Sending is final. Each member below receives a legal demand under
            Section 4.9 for the amount shown. The notice is effective when the
            email is sent and cannot be withdrawn; the due date printed in it is
            binding. If a member does not pay in full by the due date, the
            default provisions of Section 4.9 apply (
            {noticeTerms.defaultInterestRate} interest, suspension and, after{" "}
            {noticeTerms.curePeriod}, forfeiture).
          </DialogDescription>
        </DialogHeader>

        {sendBlockedReason ? (
          <Alert variant="destructive">
            <AlertTitle>Sending is blocked</AlertTitle>
            <AlertDescription>{sendBlockedReason}</AlertDescription>
          </Alert>
        ) : mailCatcher ? (
          <Alert variant="destructive">
            <AlertTitle>Test mode</AlertTitle>
            <AlertDescription>
              Test mode: emails go to the mail catcher and are not delivered.
            </AlertDescription>
          </Alert>
        ) : null}

        {results ? (
          <div className="grid gap-3 text-sm">
            {sentDueOn ? (
              <p>
                Due date printed in the notices:{" "}
                <strong>
                  <IsoDateText date={sentDueOn} />
                </strong>
              </p>
            ) : null}
            <ul className="grid gap-1">
              {results.map((r) => {
                const who = names.get(r.lineId);
                return (
                  <li key={r.lineId} className="flex flex-wrap gap-2">
                    <span className="font-medium">{who?.name ?? r.lineId}</span>
                    {r.ok ? (
                      <Badge variant="success">Sent</Badge>
                    ) : r.emailSent && r.status === "SENDING" ? (
                      <Badge variant="warning">
                        Email sent; not recorded — resolve on the notice page
                      </Badge>
                    ) : r.emailSent ? (
                      <Badge variant="warning">
                        Email sent; prepaid money to re-match
                      </Badge>
                    ) : (
                      <Badge variant="destructive">Failed</Badge>
                    )}
                    {r.error ? (
                      <span className="text-muted-foreground">{r.error}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {results.some((r) => !r.ok && r.emailSent) ? (
              <p className="text-muted-foreground">
                Lines marked &quot;Email sent&quot; were delivered to the mail
                server and are legally sent; they are not retried.
              </p>
            ) : null}
            {error ? <p className="text-destructive">{error}</p> : null}
            <DialogFooter>
              {retry.length > 0 && !blocked ? (
                <Button
                  variant="outline"
                  onClick={() => run(retry)}
                  loading={mutation.isPending}
                  disabled={mutation.isPending}
                >
                  Retry failed ({retry.length})
                </Button>
              ) : null}
              <Button onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-3 text-sm">
            <p>
              Due date if sent now:{" "}
              <strong>
                {proposedDueOn ? <IsoDateText date={proposedDueOn} /> : "—"}
              </strong>
            </p>
            <ul className="grid max-h-60 gap-1 overflow-auto rounded border p-2">
              {recipients.map((r) => (
                <li key={r.lineId} className="flex justify-between gap-2">
                  <span>
                    {r.name}{" "}
                    <span className="text-muted-foreground">
                      {r.email ?? "no email"}
                    </span>
                    {r.failed ? (
                      <Badge variant="destructive" className="ml-2">
                        previously failed
                      </Badge>
                    ) : null}
                  </span>
                  <Money cents={r.amountCalled} />
                </li>
              ))}
            </ul>
            {blocked && !sendBlockedReason ? (
              <p className="text-destructive">{blocked}</p>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="cn-confirm">
                Type the notice number ({noticeNumber}) to confirm
              </Label>
              <Input
                id="cn-confirm"
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            {error ? <p className="text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={() => run()}
                loading={mutation.isPending}
                disabled={mutation.isPending || !confirmed || blocked !== null}
              >
                Send to {recipients.length} member
                {recipients.length === 1 ? "" : "s"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Cancel a draft (the number is kept). */
export function CancelDraftButton({
  id,
  number,
}: {
  id: string;
  number: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = api.callNotice.cancelDraft.useMutation();

  const submit = async () => {
    if (reason.trim() === "") {
      setError("Give a reason.");
      return;
    }
    setError(null);
    try {
      await mutation.mutateAsync({ id, reason: reason.trim() });
      toast.success(`Draft Call Notice No. ${number} cancelled.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Cancel draft</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel draft Call Notice No. {number}</DialogTitle>
          <DialogDescription>
            Nothing has been sent. The draft is kept as cancelled and its number
            is not reused.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="cn-cancel-reason">Reason</Label>
          <Textarea
            id="cn-cancel-reason"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={submit}
            loading={mutation.isPending}
            disabled={mutation.isPending}
          >
            Cancel draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
