"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { getPresignedGetUrl } from "@/server/file-upload-actions";
import { trimUnits } from "@/server/llc/serialize";
import { api } from "@/trpc/react";
import { useReview } from "./review-context";

// Section 5 of the confirmation screen (F13): the Manager's countersignature.
// `admission.prepareCountersign` writes the ledger figures the Manager sees
// here on the Manager's lines and returns a single-use signing token; the
// browser goes to `/esign/<token>` straight away (the token is never kept).
// Preparing again is safe: it issues a new link and kills the old one. The
// signing step checks the figures against the ledger again.

function ReassignDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { view, managers, busy, applyView, onError } = useReview();
  const [memberId, setMemberId] = useState("");
  useEffect(() => {
    if (open) setMemberId("");
  }, [open]);

  const mutation = api.admission.reassignManager.useMutation({
    onSuccess: (next) => {
      toast.success(
        `${next.manager.name ?? "The new signer"} will countersign.`,
      );
      onOpenChange(false);
      applyView(next);
    },
    onError,
  });

  const options = (managers ?? []).filter(
    (m) => m.memberId !== view.manager.memberId,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign signer</DialogTitle>
          <DialogDescription>
            Choose the team member who countersigns for the Manager. Any
            countersignature link prepared earlier stops working.
          </DialogDescription>
        </DialogHeader>
        {managers === null ? (
          <p className="text-sm text-muted-foreground">
            You cannot see the team list, so you cannot choose another signer.
          </p>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There is no other active team member with a name and an email.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="cs-signer">Signer</Label>
            <Select value={memberId || undefined} onValueChange={setMemberId}>
              <SelectTrigger id="cs-signer">
                <SelectValue placeholder="Select a team member" />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m.memberId} value={m.memberId}>
                    {m.name} ({m.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={!memberId || busy}
            loading={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                publicId: view.packet.publicId,
                managerMemberId: memberId,
              })
            }
          >
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SignerLine() {
  const { view, busy } = useReview();
  const [open, setOpen] = useState(false);
  const { manager, packet } = view;
  const changeable =
    manager.status !== "SIGNED" &&
    (packet.stage === "AWAITING_INVESTOR" ||
      packet.stage === "AWAITING_REVIEW" ||
      packet.stage === "AWAITING_COUNTERSIGN");
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span>
        Countersigns for the Manager:{" "}
        <span className="font-medium">
          {manager.name ?? "nobody"}
          {manager.email ? ` (${manager.email})` : ""}
        </span>
        {manager.isCurrentUser ? " — you" : ""}
      </span>
      {changeable ? (
        <Allow subject="commitments" action="update">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            Reassign signer
          </Button>
          <ReassignDialog open={open} onOpenChange={setOpen} />
        </Allow>
      ) : null}
    </div>
  );
}

const openDocument = async (key: string) => {
  try {
    const file = await getPresignedGetUrl(key);
    window.open(file.url, "_blank");
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "Could not open the file.",
    );
  }
};

export function CountersignSection() {
  const router = useRouter();
  const { view, busy, reload, onError, companyPublicId } = useReview();
  const [navigating, setNavigating] = useState(false);
  const { packet, manager, countersign, signedDocument } = view;

  const prepare = api.admission.prepareCountersign.useMutation({
    onSuccess: ({ token }) => {
      // Single use: go now, never keep it.
      setNavigating(true);
      router.push(`/esign/${token}`);
    },
    onError,
  });

  // The PDF job completes a countersigned packet within seconds: check
  // again on its own for a while so the page moves on to COMPLETE.
  const finalising = packet.stage === "FINALISING";
  useEffect(() => {
    if (!finalising) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > 40) {
        clearInterval(timer);
        return;
      }
      reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [finalising, reload]);

  const memberHref = `/${companyPublicId}/stakeholders/${view.stakeholder.id}`;
  let body: React.ReactNode = null;

  if (packet.stage === "AWAITING_COUNTERSIGN") {
    body = (
      <div className="flex flex-col gap-4">
        {countersign ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 rounded-md border p-3 text-sm">
            <dt className="text-muted-foreground">
              Capital Contribution received
            </dt>
            <dd className="font-medium tabular-nums">
              {formatCents(countersign.receivedCents)}
            </dd>
            <dt className="text-muted-foreground">Preferred Units issued</dt>
            <dd className="font-medium tabular-nums">
              {trimUnits(countersign.units)}
            </dd>
            <dt className="text-muted-foreground">Manager's date</dt>
            <dd>
              {countersign.managerSignDate
                ? `${formatDateOnly(countersign.managerSignDate)} (the acceptance date; you can change it when signing)`
                : "—"}
            </dd>
          </dl>
        ) : null}
        <p className="text-sm text-muted-foreground">
          These figures come from the ledger and are printed on the Manager's
          lines of Exhibit B. They are checked against the ledger again when you
          sign; if a wire is recorded or voided in between, signing is refused —
          come back here and prepare the countersignature again.
        </p>
        {manager.status === "SENT" ? (
          <p className="text-sm text-muted-foreground">
            A countersignature was prepared before. Preparing again gives a new
            link with the current figures; the old link stops working.
          </p>
        ) : null}
        <SignerLine />
        {manager.isCurrentUser ? (
          <Allow subject="commitments" action="update">
            <div>
              <Button
                disabled={busy || navigating || !countersign}
                loading={prepare.isPending || navigating}
                onClick={() => {
                  if (!countersign) return;
                  prepare.mutate({
                    publicId: packet.publicId,
                    // Exactly as `admission.get` returned them.
                    expectedReceivedCents: countersign.receivedCents,
                    expectedUnits: countersign.units,
                  });
                }}
              >
                {manager.status === "SENT"
                  ? "Prepare again and countersign"
                  : "Countersign now"}
              </Button>
            </div>
          </Allow>
        ) : (
          <Alert>
            <AlertDescription>
              Only {manager.name ?? "the designated signer"} can countersign
              this subscription. Ask them to open this page, or reassign the
              signer to yourself.
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  } else if (packet.stage === "FINALISING") {
    body = (
      <div className="flex flex-col gap-3 text-sm">
        <p>
          The Manager has countersigned. The signed document is being generated.
        </p>
        <div>
          <Button variant="outline" size="sm" disabled={busy} onClick={reload}>
            Check again
          </Button>
        </div>
      </div>
    );
  } else if (packet.stage === "COMPLETE") {
    body = (
      <div className="flex flex-col gap-3 text-sm">
        <p>
          The subscription is complete. The signed Exhibit B is filed on the
          member's Documents tab.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {signedDocument?.bucketKey ? (
            <Allow subject="documents" action="read">
              <Button
                size="sm"
                onClick={() => openDocument(signedDocument.bucketKey)}
              >
                Open {signedDocument.name}
              </Button>
            </Allow>
          ) : signedDocument ? (
            <span>{signedDocument.name}</span>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href={memberHref}>Member page</Link>
          </Button>
        </div>
      </div>
    );
  } else if (
    packet.stage === "AWAITING_INVESTOR" ||
    packet.stage === "AWAITING_REVIEW"
  ) {
    body = (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          The countersignature is prepared after the subscription is accepted.
        </p>
        <SignerLine />
      </div>
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        This subscription was{" "}
        {packet.stage === "REJECTED" ? "rejected" : "cancelled"}; there is
        nothing to countersign.
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Countersignature</CardTitle>
        <CardDescription>
          The Manager signs Exhibit B with the amount received and the units
          issued from the ledger.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
