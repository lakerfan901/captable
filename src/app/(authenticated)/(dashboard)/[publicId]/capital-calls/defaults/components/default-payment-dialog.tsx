"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
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
import {
  CONFLICT_MESSAGE,
  type DefaultViewWire,
  errorMessage,
  isConflict,
  ReviewCheckbox,
} from "./forfeiture-dialog";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A late payment by the Defaulting Member; the split comes from `previewPayment` and is sent back as `expected`. */
export function DefaultPaymentDialog({
  view,
  today,
}: {
  view: DefaultViewWire;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.recordPayment.useMutation();
  const ready =
    open &&
    ISO.test(paidOn) &&
    paidOn <= today &&
    amount !== null &&
    amount > 0;
  const preview = api.memberDefault.previewPayment.useQuery(
    { id: view.id, paidOn, amountCents: amount ?? 1 },
    { enabled: ready, retry: false, refetchOnWindowFocus: false, staleTime: 0 },
  );
  const plan =
    ready &&
    preview.data &&
    preview.data.paidOn === paidOn &&
    preview.data.amount === amount
      ? preview.data
      : null;

  const reset = () => {
    setPaidOn(today);
    setAmount(null);
    setReviewed(false);
    setError(null);
  };

  const submit = async () => {
    if (!plan || amount === null) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        id: view.id,
        paidOn,
        amountCents: amount,
        expected: {
          toBalanceCents: plan.toBalance,
          toInterestCents: plan.toInterest,
          toCostsCents: plan.toCosts,
        },
      });
      toast.success(`Payment from ${view.memberName} recorded.`);
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      setReviewed(false);
      setError(isConflict(e) ? CONFLICT_MESSAGE : errorMessage(e));
      await preview.refetch();
      router.refresh();
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
        <Button variant="outline">Record late payment</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Late payment: {view.memberName}</DialogTitle>
          <DialogDescription>
            Applied in the order set by the LLC terms (Balance, interest, costs
            by default). A payment after the Forfeiture Date does not reverse a
            forfeiture.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid gap-1.5">
            <Label htmlFor={`dp-date-${view.id}`}>Date paid</Label>
            <Input
              id={`dp-date-${view.id}`}
              type="date"
              min={view.dueOn}
              max={today}
              value={paidOn}
              onChange={(e) => {
                setPaidOn(e.target.value);
                setReviewed(false);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Amount paid</Label>
            <MoneyInput
              value={amount}
              onChange={(v) => {
                setAmount(v);
                setReviewed(false);
              }}
            />
          </div>
          {preview.error ? (
            <p className="text-destructive">{preview.error.message}</p>
          ) : plan ? (
            <>
              <ul className="grid gap-1 rounded border p-3">
                <li>
                  Owed on that date: Balance <Money cents={plan.owed.balance} />
                  , interest <Money cents={plan.owed.interest} />, costs{" "}
                  <Money cents={plan.owed.costs} />
                </li>
                <li className="font-medium">
                  <Money cents={plan.amount} /> = Balance{" "}
                  <Money cents={plan.toBalance} /> + interest{" "}
                  <Money cents={plan.toInterest} /> + costs{" "}
                  <Money cents={plan.toCosts} />
                </li>
              </ul>
              {plan.errors.length > 0 ? (
                <ul className="list-disc pl-5 text-destructive">
                  {plan.errors.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : (
                <ReviewCheckbox
                  id={`dp-review-${view.id}`}
                  checked={reviewed}
                  onChange={setReviewed}
                />
              )}
            </>
          ) : ready ? (
            <p className="text-muted-foreground">Computing the split…</p>
          ) : null}
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            loading={mutation.isPending}
            disabled={
              mutation.isPending || !plan || plan.errors.length > 0 || !reviewed
            }
          >
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
