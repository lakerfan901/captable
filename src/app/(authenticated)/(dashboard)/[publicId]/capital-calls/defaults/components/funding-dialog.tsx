"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/trpc/react";
import {
  type DefaultViewWire,
  errorMessage,
  ReviewCheckbox,
} from "./forfeiture-dialog";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** R31: a Replacement Funder funds part or all of the unpaid Balance. */
export function FundingDialog({
  view,
  today,
  stakeholders,
}: {
  view: DefaultViewWire;
  today: string;
  stakeholders: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { opensOn, closesOn } = view.replacementWindow;
  const maxDate = closesOn < today ? closesOn : today;
  const [open, setOpen] = useState(false);
  const [funderId, setFunderId] = useState("");
  const [fundedOn, setFundedOn] = useState(maxDate);
  const [amount, setAmount] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.recordFunding.useMutation();
  const funders = stakeholders.filter((s) => s.id !== view.stakeholderId);
  const funder = funders.find((s) => s.id === funderId);

  const reset = () => {
    setFunderId("");
    setFundedOn(maxDate);
    setAmount(null);
    setReference("");
    setReviewed(false);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!funder) {
      setError("Choose the Replacement Funder.");
      return;
    }
    if (!ISO.test(fundedOn) || fundedOn < opensOn || fundedOn > maxDate) {
      setError(
        "The funding date must fall within the replacement window and not be in the future.",
      );
      return;
    }
    if (amount === null || amount <= 0) {
      setError("Enter the amount funded.");
      return;
    }
    try {
      await mutation.mutateAsync({
        id: view.id,
        funderStakeholderId: funder.id,
        amountCents: amount,
        fundedOn,
        reference: reference.trim() || undefined,
      });
      toast.success(`Funding by ${funder.name} recorded.`);
      setOpen(false);
      reset();
      router.refresh();
    } catch (e) {
      setReviewed(false);
      setError(errorMessage(e));
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
        <Button variant="outline">Record Replacement Funder funding</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replacement Funder for {view.memberName}</DialogTitle>
          <DialogDescription>
            Section 4.9(ii). Window <IsoDateText date={opensOn} /> –{" "}
            <IsoDateText date={closesOn} />. Outstanding unpaid Balance{" "}
            <Money cents={view.outstandingBalance} />.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid gap-1.5">
            <Label>Replacement Funder</Label>
            <Select
              value={funderId}
              onValueChange={(v) => {
                setFunderId(v);
                setReviewed(false);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a stakeholder" />
              </SelectTrigger>
              <SelectContent>
                {funders.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`fd-date-${view.id}`}>Date funded</Label>
            <Input
              id={`fd-date-${view.id}`}
              type="date"
              min={opensOn}
              max={maxDate}
              value={fundedOn}
              onChange={(e) => {
                setFundedOn(e.target.value);
                setReviewed(false);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Amount funded</Label>
            <MoneyInput
              aria-label="Amount funded"
              value={amount}
              onChange={(v) => {
                setAmount(v);
                setReviewed(false);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`fd-ref-${view.id}`}>Reference</Label>
            <Input
              id={`fd-ref-${view.id}`}
              maxLength={120}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          {funder && amount !== null && amount > 0 ? (
            <div className="grid gap-2 rounded border p-3">
              <p>
                Recording this will, in one step: reduce {view.memberName}
                &apos;s accepted commitment by <Money cents={amount} />; create
                and accept a Replacement commitment of <Money cents={amount} />{" "}
                for {funder.name}; record <Money cents={amount} /> received on{" "}
                <IsoDateText date={fundedOn} />, issuing Preferred Units to{" "}
                {funder.name} with Preferred Return from that date.
              </p>
              <ReviewCheckbox
                id={`fd-review-${view.id}`}
                checked={reviewed}
                onChange={setReviewed}
              />
            </div>
          ) : null}
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            loading={mutation.isPending}
            disabled={mutation.isPending || !reviewed}
          >
            Record funding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
