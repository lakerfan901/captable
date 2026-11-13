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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { todayInTimeZone } from "@/lib/date-only";
import { type MailDeliveryState, TEST_MODE_TEXT } from "@/lib/mail-delivery";
import { useEntity } from "@/providers/entity-provider";
import { api } from "@/trpc/react";

// "Send subscription" (01-foundation.md F12): clone a ready master into a
// packet for one person and email them the signing link. The server checks
// everything again (ready master, one open subscription per person, active
// Manager signatory, mail delivery); this dialog only shapes the input.

const MAX_MESSAGE = 2000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SendMasterOption {
  publicId: string;
  name: string;
}

export interface SendPersonOption {
  id: string;
  name: string;
  email: string;
}

export interface SendManagerOption {
  memberId: string;
  name: string;
  email: string;
}

type PersonMode = "existing" | "new";

export function SendSubscriptionDialog({
  trigger,
  masters,
  people,
  managers,
  finalClosingDate,
  mailDelivery,
}: {
  trigger: React.ReactNode;
  /** Ready masters only. */
  masters: SendMasterOption[];
  /** Existing Members and prospects. */
  people: SendPersonOption[];
  /** ACTIVE team members with a name and an email. */
  managers: SendManagerOption[];
  /** The PREFERRED class's Final Closing Date (YYYY-MM-DD), if set. */
  finalClosingDate: string | null;
  mailDelivery: MailDeliveryState;
}) {
  const router = useRouter();
  const { timezone } = useEntity();
  const [open, setOpen] = useState(false);
  const [masterPublicId, setMasterPublicId] = useState("");
  const [mode, setMode] = useState<PersonMode>("existing");
  const [stakeholderId, setStakeholderId] = useState("");
  const [prospectName, setProspectName] = useState("");
  const [prospectEmail, setProspectEmail] = useState("");
  const [managerMemberId, setManagerMemberId] = useState("");
  const [message, setMessage] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  // Reset on opening only (not when a refresh hands in new option arrays).
  function onOpenChange(next: boolean) {
    if (next) {
      setMasterPublicId(
        masters.length === 1 ? (masters[0]?.publicId ?? "") : "",
      );
      setMode(people.length === 0 ? "new" : "existing");
      setStakeholderId("");
      setProspectName("");
      setProspectEmail("");
      setManagerMemberId(
        managers.length === 1 ? (managers[0]?.memberId ?? "") : "",
      );
      setMessage("");
      setServerError(null);
    }
    setOpen(next);
  }

  const { mutateAsync, isPending } = api.admission.send.useMutation({
    onSuccess: () => {
      toast.success("Subscription sent.");
      setOpen(false);
      router.refresh();
    },
    onError: (error) => {
      setServerError(error.message);
      toast.error(error.message);
    },
  });

  const today = todayInTimeZone(timezone);
  const afterFinalClosing =
    finalClosingDate !== null && today > finalClosingDate;

  const personOk =
    mode === "existing"
      ? stakeholderId !== ""
      : prospectName.trim().length > 0 && EMAIL.test(prospectEmail.trim());
  const canSubmit =
    masterPublicId !== "" &&
    managerMemberId !== "" &&
    personOk &&
    message.length <= MAX_MESSAGE &&
    mailDelivery.blockedReason === null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setServerError(null);
    await mutateAsync({
      masterPublicId,
      managerMemberId,
      ...(mode === "existing"
        ? { stakeholderId }
        : {
            prospect: {
              name: prospectName.trim(),
              email: prospectEmail.trim(),
            },
          }),
      message: message.trim() || undefined,
    }).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send subscription</DialogTitle>
          <DialogDescription>
            The investor is emailed a link to fill in and sign the Exhibit B
            signature page, then to upload a Form W-9.
          </DialogDescription>
        </DialogHeader>

        {mailDelivery.blockedReason ? (
          <Alert variant="destructive">
            <AlertTitle>Sending is blocked</AlertTitle>
            <AlertDescription>{mailDelivery.blockedReason}</AlertDescription>
          </Alert>
        ) : mailDelivery.testMode ? (
          <Alert variant="destructive">
            <AlertTitle>Test mode</AlertTitle>
            <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
          </Alert>
        ) : null}

        {afterFinalClosing ? (
          <Alert variant="destructive">
            <AlertDescription>
              The Final Closing Date has passed. Only Replacement Funders and
              Substitute Members may be admitted (Section 4.8).
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Master</Label>
            <Select value={masterPublicId} onValueChange={setMasterPublicId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a master" />
              </SelectTrigger>
              <SelectContent>
                {masters.map((m) => (
                  <SelectItem key={m.publicId} value={m.publicId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Investor</Label>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as PersonMode)}
              className="flex gap-6"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  value="existing"
                  id="person-existing"
                  disabled={people.length === 0}
                />
                <Label htmlFor="person-existing" className="font-normal">
                  Existing member or prospect
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="new" id="person-new" />
                <Label htmlFor="person-new" className="font-normal">
                  New person
                </Label>
              </div>
            </RadioGroup>
            {mode === "existing" ? (
              <Select value={stakeholderId} onValueChange={setStakeholderId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a person" />
                </SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  aria-label="Name"
                  placeholder="Name"
                  value={prospectName}
                  maxLength={200}
                  onChange={(e) => setProspectName(e.target.value)}
                />
                <Input
                  aria-label="Email"
                  type="email"
                  placeholder="Email"
                  value={prospectEmail}
                  maxLength={254}
                  onChange={(e) => setProspectEmail(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Manager signatory</Label>
            <Select value={managerMemberId} onValueChange={setManagerMemberId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose who countersigns" />
              </SelectTrigger>
              <SelectContent>
                {managers.map((m) => (
                  <SelectItem key={m.memberId} value={m.memberId}>
                    {m.name} ({m.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {managers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No active team member with a name and an email.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="sendMessage">Message (optional)</Label>
            <Textarea
              id="sendMessage"
              value={message}
              maxLength={MAX_MESSAGE}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          {serverError ? (
            <p className="text-sm text-red-600">{serverError}</p>
          ) : null}

          <DialogFooter>
            <Button type="submit" loading={isPending} disabled={!canSubmit}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
