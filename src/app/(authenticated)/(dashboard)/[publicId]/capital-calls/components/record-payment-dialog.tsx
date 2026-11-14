"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

type PaymentResult = RouterOutputs["callNotice"]["recordPayment"];

/** R29: a Balance payment is applied to the member's open lines oldest due date first; any excess is prepaid. */
export function RecordPaymentDialog({
  commitmentId,
  memberName,
  outstanding,
  today,
}: {
  commitmentId: string;
  memberName: string;
  outstanding: number;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [receivedOn, setReceivedOn] = useState(today);
  const [amount, setAmount] = useState<number | null>(outstanding);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const mutation = api.callNotice.recordPayment.useMutation();

  const reset = () => {
    setReceivedOn(today);
    setAmount(outstanding);
    setReference("");
    setNote("");
    setError(null);
    setResult(null);
  };

  const submit = async () => {
    setError(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || receivedOn > today) {
      setError("Enter the date received (not in the future).");
      return;
    }
    if (amount === null || amount <= 0) {
      setError("Enter the amount received.");
      return;
    }
    try {
      const r = await mutation.mutateAsync({
        commitmentId,
        receivedOn,
        amountCents: amount,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      });
      setResult(r);
      toast.success(`Payment from ${memberName} recorded.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Record payment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment: {memberName}</DialogTitle>
          <DialogDescription>
            The payment is applied to this member&apos;s open lines, oldest due
            date first. Any excess is held as prepaid Balance. Units are issued
            on receipt.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="grid gap-3 text-sm">
            {result.allocations.length === 0 ? (
              <p>
                No open line was paid by this receipt; it is held as prepaid
                Balance.
              </p>
            ) : (
              <ul className="grid gap-1">
                {result.allocations.map((a) => (
                  <li key={a.lineId}>
                    <Money cents={a.amount} /> to the line due{" "}
                    <IsoDateText date={a.dueOn} />; Preferred Return from{" "}
                    <IsoDateText date={a.prefReturnStartOn} />
                  </li>
                ))}
              </ul>
            )}
            {result.prepaid > 0 ? (
              <p>
                <Money cents={result.prepaid} /> held as prepaid Balance.
              </p>
            ) : null}
            {result.late ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Part of this payment arrived after its due date. Nothing
                  happens automatically: if interest is to be charged under
                  Section 4.9, declare a default for this line.
                </AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`rp-date-${commitmentId}`}>Date received</Label>
                <Input
                  id={`rp-date-${commitmentId}`}
                  type="date"
                  max={today}
                  value={receivedOn}
                  onChange={(e) => setReceivedOn(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Amount received</Label>
                <MoneyInput
                  aria-label="Amount received"
                  value={amount}
                  onChange={setAmount}
                />
                <p className="text-xs text-muted-foreground">
                  Outstanding on this line: <Money cents={outstanding} />
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`rp-ref-${commitmentId}`}>Reference</Label>
                <Input
                  id={`rp-ref-${commitmentId}`}
                  maxLength={120}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`rp-note-${commitmentId}`}>Memo</Label>
                <Textarea
                  id={`rp-note-${commitmentId}`}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                onClick={submit}
                loading={mutation.isPending}
                disabled={mutation.isPending}
              >
                Record payment
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
