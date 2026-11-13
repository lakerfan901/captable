"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { displayUnits } from "@/lib/governance/transfer-core";
import { fromMicro, toMicro } from "@/lib/llc/voting";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { classKindLabel, unitsText } from "./transfer-table";

// The three irreversible or closing actions of a transfer (03-governance.md
// G17 sections 7–9): record (complete) the transfer, admit the transferee as
// a Substitute Member, cancel the transfer. Each dialog stays open on a
// refusal and lists the server's messages one per line.

export type TransferGet = RouterOutputs["unitTransfer"]["get"];

export type CompleteResult = RouterOutputs["unitTransfer"]["complete"];

export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** A server refusal; several rules are joined by line breaks. */
export function ErrorLines({
  title,
  message,
}: {
  title?: string;
  message: string;
}) {
  const lines = message.split("\n").filter((l) => l.trim() !== "");
  return (
    <Alert variant="destructive">
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>
        {lines.length > 1 ? (
          <ul className="list-disc space-y-1 pl-4">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines may repeat
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>{lines[0] ?? message}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Complete

/** Transferor's units before and after, as of the completion as-of date. */
export function unitsAfter(fromUnits: string, units: string): string | null {
  try {
    const after = toMicro(fromUnits) - toMicro(units);
    return after < 0n ? null : fromMicro(after);
  } catch {
    return null;
  }
}

export function CompleteDialog({
  data,
  open,
  onOpenChange,
  onCompleted,
}: {
  data: TransferGet;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: (result: CompleteResult) => void;
}) {
  const router = useRouter();
  const complete = api.unitTransfer.complete.useMutation();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    onOpenChange(false);
    setConfirmed(false);
    setError(null);
  };

  const effectiveOn = data.effectiveOnIfCompleted;
  const after = unitsAfter(data.fromUnits, data.units);
  const toName = data.toName ?? "the transferee";
  const alreadyMember = data.toMemberStatus === "MEMBER";
  const classText =
    data.unitClassName ?? `${classKindLabel(data.unitClassKind)} Units`;

  const submit = async () => {
    if (!confirmed || complete.isPending) return;
    setError(null);
    try {
      const result = await complete.mutateAsync({ publicId: data.publicId });
      toast.success(
        `Transfer recorded, effective ${formatDateOnly(result.effectiveOn)}.`,
      );
      onCompleted(result);
      close();
      router.refresh();
    } catch (e) {
      setError(errorText(e, "The transfer could not be recorded."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Record the transfer</DialogTitle>
          <DialogDescription>
            Check every line. Recording the transfer moves the Units on the
            effective date and cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="font-medium">{data.fromName}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="font-medium">{toName}</dd>
          <dt className="text-muted-foreground">Units</dt>
          <dd>
            <span className="font-medium">
              {unitsText(data.units, data.unitClassKind)}
            </span>{" "}
            <span className="text-muted-foreground">(class {classText})</span>
          </dd>
          <dt className="text-muted-foreground">Effective</dt>
          <dd className="font-medium">
            {effectiveOn ? formatDateOnly(effectiveOn) : "—"}
          </dd>
          <dt className="text-muted-foreground">{data.fromName} holds</dt>
          <dd>
            <span className="tabular-nums">
              {displayUnits(data.fromUnits)} before,{" "}
              {after === null ? "—" : displayUnits(after)} after
            </span>{" "}
            <span className="text-muted-foreground">
              ({classKindLabel(data.unitClassKind)} Units as of{" "}
              {formatDateOnly(data.completionUnitsAsOf)})
            </span>
          </dd>
        </dl>

        <div className="space-y-2 text-sm">
          <p>
            Units move on {effectiveOn ? formatDateOnly(effectiveOn) : "—"}
            {data.unitClassKind === "PREFERRED"
              ? ", with the related capital and accrued Preferred Return,"
              : ", with the related capital,"}{" "}
            from {data.fromName} to {toName}.
          </p>
          {alreadyMember ? (
            <p>
              {toName} is already a Member: the Units are held as a Member from
              the effective date, and the transfer is recorded as admitted
              today.
            </p>
          ) : (
            <p>
              {toName} will hold a Financial Interest only until admitted as a
              Substitute Member (Section 7.8): distributions and allocations,
              but no vote.
            </p>
          )}
          <p className="font-medium">This cannot be undone.</p>
        </div>

        <div className="flex items-start gap-2">
          <Checkbox
            id="complete-confirm"
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor="complete-confirm" className="font-normal">
            I have checked the parties, the Units and the effective date, and
            want to record this transfer.
          </Label>
        </div>

        {error ? (
          <ErrorLines title="The transfer was not recorded" message={error} />
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!confirmed || complete.isPending}
            onClick={() => void submit()}
          >
            {complete.isPending ? "Recording…" : "Record the transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Admit

export function AdmitDialog({
  data,
  admittedOn,
  open,
  onOpenChange,
}: {
  data: TransferGet;
  admittedOn: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const admit = api.unitTransfer.admit.useMutation();
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    onOpenChange(false);
    setError(null);
  };

  const submit = async () => {
    if (admit.isPending) return;
    setError(null);
    try {
      const res = await admit.mutateAsync({
        publicId: data.publicId,
        admittedOn,
      });
      toast.success(
        `${data.toName ?? "The transferee"} admitted as a Member on ${formatDateOnly(res.admittedOn)}.`,
      );
      close();
      router.refresh();
    } catch (e) {
      setError(errorText(e, "The transferee could not be admitted."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Admit as Member</DialogTitle>
          <DialogDescription>
            {data.toName ?? "The transferee"} becomes a Substitute Member on{" "}
            {formatDateOnly(admittedOn)} (Section 7.8). Its Units count for
            votes with a record date on or after that day, and the Member
            Schedule (Exhibit A) is updated.
          </DialogDescription>
        </DialogHeader>
        {error ? <ErrorLines title="Not admitted" message={error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={admit.isPending} onClick={() => void submit()}>
            {admit.isPending ? "Admitting…" : "Admit as Member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Cancel

export function CancelTransferDialog({
  data,
  open,
  onOpenChange,
}: {
  data: TransferGet;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const cancel = api.unitTransfer.cancel.useMutation();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    onOpenChange(false);
    setReason("");
    setError(null);
  };
  const canSubmit = reason.trim() !== "" && !cancel.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await cancel.mutateAsync({
        publicId: data.publicId,
        reason: reason.trim(),
      });
      toast.success("Transfer cancelled.");
      close();
      router.refresh();
    } catch (e) {
      setError(errorText(e, "The transfer could not be cancelled."));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cancel transfer</DialogTitle>
          <DialogDescription>
            The transfer is closed without moving any Units, and its open
            deadlines are marked not applicable. A cancelled transfer cannot be
            reopened; record a new one instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            maxLength={500}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error ? <ErrorLines message={error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Keep the transfer
          </Button>
          <Button
            variant="destructive"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {cancel.isPending ? "Cancelling…" : "Cancel transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
