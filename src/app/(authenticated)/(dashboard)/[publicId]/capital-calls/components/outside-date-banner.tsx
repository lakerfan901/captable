"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { formatDateOnly } from "@/lib/date-only";
import { api } from "@/trpc/react";

/** R27: from the Balance outside date every uncalled Balance is due without notice. */
export function OutsideDateBanner({
  outsideDate,
  canCreate,
}: {
  outsideDate: string;
  canCreate: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = api.callNotice.createOutsideDateNotice.useMutation();
  const longDate = formatDateOnly(outsideDate);

  const confirm = async () => {
    setError(null);
    try {
      const r = await mutation.mutateAsync({ confirm: true });
      toast.success(
        `Recorded as Call Notice No. ${r.number} (${r.lineCount} member${r.lineCount === 1 ? "" : "s"}).`,
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Alert variant="destructive">
      <AlertTitle>The Balance is due without notice</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>
          Under Section 4.9 every uncalled Balance is due on {longDate} whether
          or not a Call Notice was given. Call Notices can no longer be sent.
          Record the Balance due so each member&apos;s unpaid amount has a due
          date and can be tracked, paid or defaulted.
        </p>
        {canCreate ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="w-fit">
                Record Balance due on {longDate}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Record Balance due on {longDate}</DialogTitle>
                <DialogDescription>
                  This creates one line per member with an uncalled Balance, for
                  the whole uncalled amount, due {longDate}. Money already
                  received before a notice is matched first. No email is sent.
                  This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
              <DialogFooter>
                <Button
                  onClick={confirm}
                  loading={mutation.isPending}
                  disabled={mutation.isPending}
                >
                  Record Balance due
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
