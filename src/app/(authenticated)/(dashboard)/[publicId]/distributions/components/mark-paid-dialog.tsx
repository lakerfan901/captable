"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Money } from "@/components/llc/money";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";

export type PayableLine = {
  id: string;
  name: string;
  netCents: number;
  paidOn: string | null;
  paymentReference: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Records that the net amounts of chosen lines were paid (operational columns only; no economic effect). */
export function MarkPaidDialog({
  distributionId,
  lines,
  onDone,
}: {
  distributionId: string;
  lines: PayableLine[];
  onDone: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(lines.filter((l) => l.paidOn === null).map((l) => l.id)),
  );
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = api.distribution.markPaid.useMutation();

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = async () => {
    setError(null);
    if (selected.size === 0) {
      setError("Choose at least one member.");
      return;
    }
    if (!ISO_DATE.test(paidOn)) {
      setError("Enter the date the payment was made.");
      return;
    }
    if (reference.trim().length > 100) {
      setError("The payment reference must be at most 100 characters.");
      return;
    }
    try {
      const r = await mutation.mutateAsync({
        id: distributionId,
        lineIds: [...selected],
        paidOn,
        paymentReference: reference.trim() || undefined,
      });
      toast.success(`${r.updated} line(s) marked paid.`);
      setOpen(false);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Mark paid</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark payments made</DialogTitle>
          <DialogDescription>
            Records the date and bank reference of the payment to each chosen
            member. This does not change any amount of the distribution.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            {lines.map((l) => (
              <div key={l.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`paid-${l.id}`}
                  checked={selected.has(l.id)}
                  onCheckedChange={(v) => toggle(l.id, v === true)}
                />
                <Label htmlFor={`paid-${l.id}`} className="flex-1">
                  {l.name}
                </Label>
                <Money cents={l.netCents} />
                {l.paidOn ? (
                  <span className="text-xs text-muted-foreground">
                    paid {l.paidOn}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`paid-on-${distributionId}`}>Paid on</Label>
            <Input
              id={`paid-on-${distributionId}`}
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`paid-ref-${distributionId}`}>
              Payment reference (optional)
            </Label>
            <Input
              id={`paid-ref-${distributionId}`}
              value={reference}
              maxLength={100}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={mutation.isPending}
            loading={mutation.isPending}
          >
            Mark paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
