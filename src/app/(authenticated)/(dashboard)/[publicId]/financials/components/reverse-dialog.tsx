"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ZReverseSchema } from "@/trpc/routers/llc-financials/schema";

/**
 * Reason-required reversal of an immutable ledger row. `onReverse` runs the
 * router's `reverse` mutation and rejects with its error (shown inline).
 */
export function ReverseDialog({
  id,
  title,
  description,
  onReverse,
}: {
  id: string;
  title: string;
  description?: string;
  onReverse: (input: { id: string; reason: string }) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const parsed = ZReverseSchema.safeParse({ id, reason });
    if (!parsed.success) {
      setError("Give a reason of at least 5 characters.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onReverse(parsed.data);
      setOpen(false);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reverse
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ??
              "Entries are never deleted. A reversal entry dated today cancels this one; both stay on the record."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={`reverse-reason-${id}`}>Reason</Label>
          <Textarea
            id={`reverse-reason-${id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={pending}
            loading={pending}
          >
            Reverse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
