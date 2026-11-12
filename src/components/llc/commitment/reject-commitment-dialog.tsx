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
import { Textarea } from "@/components/ui/textarea";
import { computeSubscriptionClock } from "@/lib/admission/commitment-rules";
import {
  formatDateOnly,
  isValidDateOnly,
  todayInTimeZone,
} from "@/lib/date-only";
import { addBusinessDays } from "@/lib/llc/business-days";
import { formatCents } from "@/lib/money";
import { useEntity } from "@/providers/entity-provider";
import { api } from "@/trpc/react";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";
import { liveHeldReceipts } from "./decide-commitment-dialog";

/** The refund date the server will set (the server result is authoritative). */
function refundDueByPreview(
  c: CommitmentDTO,
  unitClass: UnitClassDTO | null,
  decidedOn: string,
): string | null {
  if (!unitClass || !isValidDateOnly(decidedOn)) return null;
  const clock = computeSubscriptionClock(
    {
      signedOn: c.signedOn,
      committedCents: BigInt(c.committedCents),
      initialInstallmentBps: unitClass.initialInstallmentBps,
      receipts: liveHeldReceipts(c),
      acceptanceBusinessDays: unitClass.acceptanceBusinessDays,
      refundBusinessDays: unitClass.refundBusinessDays,
      finalClosingDate: unitClass.finalClosingDate,
    },
    addBusinessDays,
  );
  return (
    clock.refundDueBy ??
    addBusinessDays(decidedOn, unitClass.refundBusinessDays)
  );
}

export function RejectCommitmentDialog({
  commitment,
  unitClass,
  open,
  onOpenChange,
}: {
  commitment: CommitmentDTO;
  unitClass: UnitClassDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { timezone } = useEntity();
  const today = todayInTimeZone(timezone);
  const [decidedOn, setDecidedOn] = useState(today);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) {
      setDecidedOn(today);
      setReason("");
    }
  }, [open, today]);

  const { mutateAsync, isPending } = api.commitment.reject.useMutation({
    onSuccess: () => {
      toast.success("Commitment rejected.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const errors: string[] = [];
  if (!isValidDateOnly(decidedOn)) errors.push("Enter the decision date.");
  else if (decidedOn > today)
    errors.push("The decision date cannot be in the future.");
  if (reason.trim().length < 3)
    errors.push("Give a reason for the rejection (at least 3 characters).");

  const held = commitment.heldCents;
  const refundBy =
    held > 0 ? refundDueByPreview(commitment, unitClass, decidedOn) : null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (errors.length > 0) return;
    await mutateAsync({
      id: commitment.id,
      decidedOn,
      reason: reason.trim(),
    }).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject commitment</DialogTitle>
          <DialogDescription>
            {formatCents(commitment.committedCents)} committed by{" "}
            {commitment.stakeholderName}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="decidedOn">Decision date</Label>
            <Input
              id="decidedOn"
              type="date"
              max={today}
              value={decidedOn}
              onChange={(e) => setDecidedOn(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {held > 0 ? (
            <p className="text-sm text-amber-600">
              The {formatCents(held)} received must be returned
              {refundBy ? ` by ${formatDateOnly(refundBy)}` : ""}.
            </p>
          ) : null}
          {errors.map((message) => (
            <p key={message} className="text-sm text-red-600">
              {message}
            </p>
          ))}
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              loading={isPending}
              disabled={errors.length > 0}
            >
              Reject
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
