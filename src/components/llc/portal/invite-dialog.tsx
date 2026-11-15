"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { type MailDeliveryState, TEST_MODE_TEXT } from "@/lib/mail-delivery";
import { api } from "@/trpc/react";

/**
 * "Invite to portal" (04-investor-portal.md 6.2; package P3). The address is
 * prefilled from the holder's effective notice email; the Manager user
 * confirms or changes it (P1, P3). The answer never says whether the person
 * already had a portal account.
 */
export function InviteDialog({
  stakeholderId,
  holderName,
  defaultEmail,
  mailDelivery,
  onInvited,
}: {
  stakeholderId: string;
  holderName: string;
  defaultEmail: string;
  mailDelivery: MailDeliveryState;
  onInvited: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail);
  const [error, setError] = useState<string | null>(null);

  const mutation = api.portalAdmin.invite.useMutation({
    onSuccess: (result) => {
      if (result.outcome === "ALREADY_ACTIVE") {
        toast.info(
          `${result.email} already has portal access for ${holderName}.`,
        );
      } else {
        toast.success(`Invitation sent to ${result.email}.`);
      }
      setOpen(false);
      onInvited();
    },
    onError: (e) => setError(e.message),
  });

  const blocked = mailDelivery.blockedReason;
  const trimmed = email.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setEmail(defaultEmail);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Invite to portal</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite to portal</DialogTitle>
          <DialogDescription>
            Invite a person to the investor portal for {holderName}. The email
            is prefilled from the notice email.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (!trimmed) {
              setError("Enter an email address.");
              return;
            }
            mutation.mutate({ stakeholderId, email: trimmed });
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="portal-invite-email">Email</Label>
            <Input
              id="portal-invite-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            This person will be able to see the documents shared with{" "}
            {holderName} and the reports released to them.
          </p>
          {blocked ? (
            <Alert variant="destructive">
              <AlertDescription>{blocked}</AlertDescription>
            </Alert>
          ) : mailDelivery.testMode ? (
            <Alert>
              <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
            </Alert>
          ) : null}
          {error && (
            <p className="text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={blocked !== null || mutation.isPending}
              loading={mutation.isPending}
            >
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
