"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import { type DefaultViewWire, errorMessage } from "./forfeiture-dialog";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** §4.9(v): costs of collection charged to the Defaulting Member. */
export function ChargeDialog({
  view,
  today,
}: {
  view: DefaultViewWire;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [incurredOn, setIncurredOn] = useState(today);
  const [amount, setAmount] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.addCharge.useMutation();

  const reset = () => {
    setIncurredOn(today);
    setAmount(null);
    setDescription("");
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (
      !ISO.test(incurredOn) ||
      incurredOn < view.dueOn ||
      incurredOn > today
    ) {
      setError(
        "The date must be on or after the due date and not in the future.",
      );
      return;
    }
    if (amount === null || amount <= 0) {
      setError("Enter the amount.");
      return;
    }
    if (description.trim() === "") {
      setError("Describe the cost.");
      return;
    }
    try {
      await mutation.mutateAsync({
        id: view.id,
        incurredOn,
        amountCents: amount,
        description: description.trim(),
      });
      toast.success("Cost recorded.");
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
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
        <Button variant="outline">Add cost</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cost of collection: {view.memberName}</DialogTitle>
          <DialogDescription>
            Section 4.9(v): costs of collection are owed by the Defaulting
            Member and may be withheld from its distributions.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid gap-1.5">
            <Label htmlFor={`ch-date-${view.id}`}>Date incurred</Label>
            <Input
              id={`ch-date-${view.id}`}
              type="date"
              min={view.dueOn}
              max={today}
              value={incurredOn}
              onChange={(e) => setIncurredOn(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`ch-desc-${view.id}`}>Description</Label>
            <Textarea
              id={`ch-desc-${view.id}`}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            loading={mutation.isPending}
            disabled={mutation.isPending}
          >
            Add cost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
