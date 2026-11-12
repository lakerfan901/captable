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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { api } from "@/trpc/react";
import type { ReceiptDTO } from "@/trpc/routers/commitment-router/dto";

export function VoidReceiptDialog({
  receipt,
  stakeholderName,
  open,
  onOpenChange,
}: {
  receipt: ReceiptDTO;
  stakeholderName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setServerError(null);
    }
  }, [open]);

  const { mutateAsync, isPending } = api.commitment.voidReceipt.useMutation({
    onSuccess: () => {
      toast.success("Receipt voided.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => {
      // The server refuses some voids (a receipt split by the acceptance,
      // or one that would leave capital or units negative); keep the dialog
      // open and show its message as is.
      setServerError(error.message);
      toast.error(error.message);
    },
  });

  const tooShort = reason.trim().length < 5;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (tooShort) return;
    setServerError(null);
    await mutateAsync({ receiptId: receipt.id, reason: reason.trim() }).catch(
      () => undefined,
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void receipt</DialogTitle>
          <DialogDescription>
            {formatCents(receipt.amountCents)} received from {stakeholderName}{" "}
            on {formatDateOnly(receipt.receivedOn)}. Receipts are never edited;
            void it and record it again to correct it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="voidReason">Reason</Label>
            <Textarea
              id="voidReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {tooShort ? (
              <p className="text-xs text-muted-foreground">
                At least 5 characters.
              </p>
            ) : null}
          </div>
          {serverError ? (
            <p className="text-sm text-red-600">{serverError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              loading={isPending}
              disabled={tooShort}
            >
              Void receipt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
