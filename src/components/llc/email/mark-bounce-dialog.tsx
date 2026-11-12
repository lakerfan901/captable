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
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import type { EmailLogDTO } from "@/trpc/routers/email-log-router/schema";

type BounceState = "BOUNCED" | "COMPLAINED";

type MarkBounceDialogProps = {
  email: EmailLogDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (email: EmailLogDTO) => void;
};

export function MarkBounceDialog({
  email,
  open,
  onOpenChange,
  onUpdated,
}: MarkBounceDialogProps) {
  const router = useRouter();
  const [state, setState] = useState<BounceState>("BOUNCED");
  const [note, setNote] = useState("");

  const { mutate, isPending } = api.emailLog.markBounce.useMutation({
    onSuccess: (updated) => {
      toast.success("Bounce recorded.");
      onUpdated(updated);
      onOpenChange(false);
      setNote("");
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as bounced</DialogTitle>
          <DialogDescription>
            “{email.subject}” to {email.toAddress}. A notice is not effective if
            you learn it was not delivered (Section 13.6).
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutate({
              id: email.id,
              bounceState: state,
              note: note.trim() || undefined,
            });
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="bounce-state">What happened</Label>
            <Select
              value={state}
              onValueChange={(v) => setState(v as BounceState)}
            >
              <SelectTrigger id="bounce-state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BOUNCED">Bounced (not delivered)</SelectItem>
                <SelectItem value="COMPLAINED">
                  Complained (spam report)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="bounce-note">Note</Label>
            <Textarea
              id="bounce-note"
              maxLength={500}
              placeholder="e.g. Bounce message received on Nov 12: mailbox full"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="submit" loading={isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
