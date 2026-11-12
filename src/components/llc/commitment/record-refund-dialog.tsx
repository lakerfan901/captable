"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidDateOnly, todayInTimeZone } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { useEntity } from "@/providers/entity-provider";
import { api } from "@/trpc/react";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";
import {
  centsFromText,
  DollarInput,
  textFromCents,
} from "./decide-commitment-dialog";

export function RecordRefundDialog({
  commitment,
  open,
  onOpenChange,
}: {
  commitment: CommitmentDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { timezone } = useEntity();
  const today = todayInTimeZone(timezone);
  const outstanding = commitment.refundOutstandingCents;
  const [amountText, setAmountText] = useState(textFromCents(outstanding));
  const [paidOn, setPaidOn] = useState(today);

  useEffect(() => {
    if (open) {
      setAmountText(textFromCents(outstanding));
      setPaidOn(today);
    }
  }, [open, outstanding, today]);

  const { mutateAsync, isPending } = api.commitment.recordRefund.useMutation({
    onSuccess: () => {
      toast.success("Refund recorded.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const paidCents = centsFromText(amountText);
  const errors: string[] = [];
  if (paidCents === null || paidCents <= 0n)
    errors.push("The amount must be more than zero.");
  else if (paidCents > BigInt(outstanding))
    errors.push(
      `Only ${formatCents(outstanding)} of the refund is outstanding.`,
    );
  if (!isValidDateOnly(paidOn)) errors.push("Enter the date paid.");
  else if (paidOn > today)
    errors.push("The refund date cannot be in the future.");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (errors.length > 0 || paidCents === null) return;
    await mutateAsync({
      id: commitment.id,
      paidCents: Number(paidCents),
      paidOn,
    }).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record refund</DialogTitle>
          <DialogDescription>
            {formatCents(outstanding)} to be returned to{" "}
            {commitment.stakeholderName}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="refundAmount">Amount</Label>
            <DollarInput
              id="refundAmount"
              value={amountText}
              onChange={setAmountText}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="paidOn">Date paid</Label>
            <Input
              id="paidOn"
              type="date"
              max={today}
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </div>
          {errors.map((message) => (
            <p key={message} className="text-sm text-red-600">
              {message}
            </p>
          ))}
          <DialogFooter>
            <Button
              type="submit"
              loading={isPending}
              disabled={errors.length > 0}
            >
              Record refund
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
