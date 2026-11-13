"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
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
import { ZReverseSchema } from "@/trpc/routers/distribution/schema";

/** Reverses a finalized distribution: a reason (10+ characters) and the distribution number typed to confirm. */
export function ReverseDialog({ id, number }: { id: string; number: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = api.distribution.reverse.useMutation();

  const submit = async () => {
    setError(null);
    const parsed = ZReverseSchema.safeParse({ id, reason });
    if (!parsed.success) {
      setError("Give a reason of at least 10 characters.");
      return;
    }
    if (typed.trim() !== String(number)) {
      setError(`Type ${number} to confirm.`);
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      toast.success(`Distribution No. ${number} reversed.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Reverse</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse distribution No. {number}</DialogTitle>
          <DialogDescription>
            Nothing is deleted. A reversal distribution cancels every ledger
            entry this distribution made (Preferred Return paid, capital
            returned, default offsets and tax advances recovered); both stay on
            the record. Money already paid to members must be recovered outside
            this system.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor={`reverse-reason-${id}`}>Reason</Label>
            <Textarea
              id={`reverse-reason-${id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`reverse-number-${id}`}>
              Type {number} to confirm
            </Label>
            <Input
              id={`reverse-number-${id}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={mutation.isPending}
            loading={mutation.isPending}
          >
            Reverse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
