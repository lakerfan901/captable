"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  centsFromText,
  DollarInput,
  liveHeldReceipts,
  termsFromUnitClass,
} from "@/components/llc/commitment/decide-commitment-dialog";
import { Allow } from "@/components/rbac/allow";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  computeSubscriptionClock,
  defaultKeepCents,
  heldOnOrBefore,
  planAcceptance,
  requiredInitialInstallmentCents,
  validateAcceptance,
} from "@/lib/admission/commitment-rules";
import { formatDateOnly, isValidDateOnly } from "@/lib/date-only";
import { addBusinessDays } from "@/lib/llc/business-days";
import { microUnitsToDecimalString } from "@/lib/llc/money";
import { microUnitsForAmount } from "@/lib/llc/units";
import { formatCents } from "@/lib/money";
import { trimUnits } from "@/server/llc/serialize";
import { api } from "@/trpc/react";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";
import { useReview } from "./review-context";

// Section 4 of the confirmation screen (F13): accept in full, accept a
// reduced amount (`commitment.accept`, always with explicit `acceptedCents`
// and `keepCents`) or reject (`admission.reject`). Every figure is shown
// before the click; it is computed with the F5 rule functions the server
// uses, and the server checks all of it again.

/** The refund date the server will set for a refund on this decision. */
function refundDueByPreview(
  c: CommitmentDTO,
  unitClass: UnitClassDTO,
  decidedOn: string,
): string {
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

type Row = { label: string; value: string; strong?: boolean };

function acceptancePreview(input: {
  c: CommitmentDTO;
  unitClass: UnitClassDTO;
  acceptedCents: bigint;
  keepText: string;
  acceptedOn: string;
  minimumWaived: boolean;
  otherAcceptedCents: bigint;
  today: string;
}) {
  const { c, unitClass } = input;
  const terms = termsFromUnitClass(unitClass);
  const receipts = liveHeldReceipts(c);
  const committed = BigInt(c.committedCents);
  const accepted = input.acceptedCents;
  const total = receipts.reduce((sum, r) => sum + r.amountCents, 0n);
  const held = heldOnOrBefore(receipts, input.acceptedOn);
  const required = c.isReplacement
    ? 0n
    : requiredInitialInstallmentCents(accepted, terms.initialInstallmentBps);
  const defaultKeep =
    accepted > 0n && committed > 0n
      ? defaultKeepCents({
          heldCents: held,
          acceptedCents: accepted,
          committedCents: committed,
        })
      : 0n;
  const typedKeep = centsFromText(input.keepText);
  const keep = input.keepText.trim() === "" ? defaultKeep : typedKeep;

  const errors =
    keep === null
      ? ["Enter the amount kept in dollars and cents."]
      : validateAcceptance({
          terms,
          committedCents: committed,
          acceptedCents: accepted,
          acceptedOn: input.acceptedOn,
          signedOn: c.signedOn,
          today: input.today,
          heldCents: held,
          keepCents: keep,
          otherAcceptedCents: input.otherAcceptedCents,
          minimumWaived: input.minimumWaived,
          isReplacement: c.isReplacement,
          skipClosingDateCheck: false,
        }).map((e) => e.message);

  const cap = terms.offeringCapCents;
  const rows: Row[] = [
    { label: "Committed", value: formatCents(committed) },
    { label: "Accepted amount", value: formatCents(accepted), strong: true },
    {
      label: `Initial installment required (${terms.initialInstallmentBps / 100}% of accepted)`,
      value: formatCents(required),
    },
    { label: "Total received", value: formatCents(total) },
    {
      label: `Received on or before ${formatDateOnly(input.acceptedOn)}`,
      value: formatCents(held),
    },
  ];
  if (terms.minCommitmentCents !== null) {
    rows.push({
      label: "Minimum (Section 3.7)",
      value: formatCents(terms.minCommitmentCents),
    });
  }
  if (cap !== null) {
    const room = cap - input.otherAcceptedCents - accepted;
    rows.push({
      label: `Room left under the ${formatCents(cap)} cap after this`,
      value: formatCents(room > 0n ? room : 0n),
    });
  }
  const notes: string[] = [];
  let unitsText = "—";
  if (keep !== null && errors.length === 0 && accepted > 0n) {
    const plan = planAcceptance({
      receipts,
      acceptedOn: input.acceptedOn,
      acceptedCents: accepted,
      keepCents: keep,
    });
    const price = unitClass.pricePerUnitCents;
    if (price === null || price <= 0) {
      errors.push("Set the price per unit of the unit class first.");
    } else {
      let micro = 0n;
      for (const row of plan.rows) {
        if (row.appliedCents > 0n) {
          micro += microUnitsForAmount(
            row.appliedCents,
            BigInt(price),
            unitClass.fractionalUnitsAllowed,
          );
        }
      }
      unitsText = trimUnits(microUnitsToDecimalString(micro));
    }
    const applied = plan.rows.reduce((sum, r) => sum + r.appliedCents, 0n);
    rows.push(
      {
        label: "Amount kept (Initial Installment)",
        value: formatCents(keep),
        strong: true,
      },
      { label: "Applied as capital", value: formatCents(applied) },
      {
        label: "Refund due",
        value:
          plan.refundCents > 0n
            ? `${formatCents(plan.refundCents)} by ${formatDateOnly(
                refundDueByPreview(c, unitClass, input.acceptedOn),
              )}`
            : formatCents(0),
        strong: plan.refundCents > 0n,
      },
      { label: "Preferred Units to be issued", value: unitsText, strong: true },
      {
        label: "Balance still to be paid",
        value: formatCents(accepted - applied),
      },
    );
    if (plan.rows.some((r) => r.kind === "BALANCE")) {
      notes.push(
        `Money received after ${formatDateOnly(input.acceptedOn)} is applied as Balance payments on the dates received.`,
      );
    }
  }
  if (held >= required) {
    // bigint: Math.min does not apply.
    let max = accepted;
    if (held < max) max = held;
    notes.push(
      `The amount kept may be between ${formatCents(required)} and ${formatCents(max)}; default ${formatCents(defaultKeep)} (pro rata).`,
    );
  }
  return { rows, errors, notes, keep, defaultKeep };
}

function AcceptDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { view, busy, onError, reload } = useReview();
  const c = view.commitment as CommitmentDTO;
  const today = view.today;
  const [acceptedOn, setAcceptedOn] = useState(today);
  const [mode, setMode] = useState<"full" | "reduce">("full");
  const [reducedText, setReducedText] = useState("");
  const [keepText, setKeepText] = useState("");
  const [waived, setWaived] = useState(false);
  const [waiverNote, setWaiverNote] = useState("");

  useEffect(() => {
    if (open) {
      setAcceptedOn(today);
      setMode("full");
      setReducedText("");
      setKeepText("");
      setWaived(false);
      setWaiverNote("");
    }
  }, [open, today]);

  const mutation = api.commitment.accept.useMutation({
    onSuccess: () => {
      toast.success("Subscription accepted.");
      onOpenChange(false);
      reload();
    },
    onError,
  });

  const committed = BigInt(c.committedCents);
  const acceptedCents =
    mode === "full" ? committed : (centsFromText(reducedText) ?? 0n);
  const minimum = view.classTerms.minCommitmentCents;
  const showWaiver =
    !c.isReplacement && minimum !== null && acceptedCents < BigInt(minimum);
  const dateValid = isValidDateOnly(acceptedOn);
  const preview = dateValid
    ? acceptancePreview({
        c,
        unitClass: view.classTerms,
        acceptedCents,
        keepText,
        acceptedOn,
        minimumWaived: showWaiver && waived,
        otherAcceptedCents: BigInt(view.otherAcceptedCents),
        today,
      })
    : null;
  const errors = preview ? preview.errors : ["Enter the acceptance date."];

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!preview || preview.keep === null || errors.length > 0) return;
    if (busy || mutation.isPending) return;
    mutation.mutate({
      id: c.id,
      acceptedOn,
      acceptedCents: Number(acceptedCents),
      keepCents: Number(preview.keep),
      minimumWaived: showWaiver ? waived : undefined,
      minimumWaiverNote:
        showWaiver && waived && waiverNote.trim()
          ? waiverNote.trim()
          : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Accept subscription</DialogTitle>
          <DialogDescription>
            {formatCents(c.committedCents)} committed by {c.stakeholderName}.
            Accepting admits them as a Member on the acceptance date and issues
            the units below.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-date">Acceptance date</Label>
            <Input
              id="a-date"
              type="date"
              max={today}
              value={acceptedOn}
              onChange={(e) => setAcceptedOn(e.target.value)}
            />
          </div>
          <RadioGroup
            value={mode}
            onValueChange={(v) => {
              setMode(v === "reduce" ? "reduce" : "full");
              setKeepText("");
            }}
            className="flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="full" id="a-full" />
              <Label htmlFor="a-full">
                Accept in full ({formatCents(c.committedCents)})
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="reduce" id="a-reduce" />
              <Label htmlFor="a-reduce">Reduce to</Label>
            </div>
          </RadioGroup>
          {mode === "reduce" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="a-reduced">Accepted amount</Label>
              <DollarInput
                id="a-reduced"
                value={reducedText}
                onChange={(v) => {
                  setReducedText(v);
                  setKeepText("");
                }}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-keep">Amount kept</Label>
            <DollarInput
              id="a-keep"
              value={keepText}
              onChange={setKeepText}
              placeholder={
                preview ? `${formatCents(preview.defaultKeep)} (pro rata)` : ""
              }
            />
          </div>
          {showWaiver ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="a-waiver"
                  checked={waived}
                  onCheckedChange={(v) => setWaived(v === true)}
                />
                <Label htmlFor="a-waiver">
                  Waive the {formatCents(minimum ?? 0)} minimum (Section 3.7)
                </Label>
              </div>
              {waived ? (
                <Textarea
                  placeholder="Waiver note"
                  value={waiverNote}
                  onChange={(e) => setWaiverNote(e.target.value)}
                />
              ) : null}
            </div>
          ) : null}
          {preview ? (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
              {preview.rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd
                    className={`text-right tabular-nums ${row.strong ? "font-medium" : ""}`}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {preview?.notes.map((note) => (
            <p key={note} className="text-sm text-muted-foreground">
              {note}
            </p>
          ))}
          {errors.map((message) => (
            <p key={message} className="text-sm text-red-600">
              {message}
            </p>
          ))}
          <DialogFooter>
            <Button
              type="submit"
              loading={mutation.isPending}
              disabled={errors.length > 0 || busy}
            >
              {mode === "full"
                ? `Accept ${formatCents(acceptedCents)}`
                : `Accept reduced ${formatCents(acceptedCents)}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { view, busy, onError, applyView } = useReview();
  const c = view.commitment as CommitmentDTO;
  const today = view.today;
  const [decidedOn, setDecidedOn] = useState(today);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) {
      setDecidedOn(today);
      setReason("");
    }
  }, [open, today]);

  const mutation = api.admission.reject.useMutation({
    onSuccess: (next) => {
      toast.success("Subscription rejected; the packet was cancelled.");
      onOpenChange(false);
      applyView(next);
    },
    onError,
  });

  const errors: string[] = [];
  if (!isValidDateOnly(decidedOn)) errors.push("Enter the decision date.");
  else if (decidedOn > today)
    errors.push("The decision date cannot be in the future.");
  if (reason.trim().length < 3)
    errors.push("Give a reason for the rejection (at least 3 characters).");
  if (reason.trim().length > 2000)
    errors.push("The reason can be at most 2,000 characters.");

  const held = c.heldCents;
  const refundBy =
    held > 0 && isValidDateOnly(decidedOn)
      ? refundDueByPreview(c, view.classTerms, decidedOn)
      : null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (errors.length > 0 || busy || mutation.isPending) return;
    mutation.mutate({
      publicId: view.packet.publicId,
      decidedOn,
      reason: reason.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject subscription</DialogTitle>
          <DialogDescription>
            {formatCents(c.committedCents)} committed by {c.stakeholderName}.
            The packet is cancelled and nobody is admitted.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="r-date">Decision date</Label>
            <Input
              id="r-date"
              type="date"
              max={today}
              value={decidedOn}
              onChange={(e) => setDecidedOn(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="r-reason">Reason</Label>
            <Textarea
              id="r-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <p
            className={
              held > 0
                ? "text-sm text-amber-600"
                : "text-sm text-muted-foreground"
            }
          >
            {held > 0
              ? `The ${formatCents(held)} received must be returned${
                  refundBy ? ` by ${formatDateOnly(refundBy)}` : ""
                }.`
              : "No money has been received; nothing is to be refunded."}
          </p>
          {errors.map((message) => (
            <p key={message} className="text-sm text-red-600">
              {message}
            </p>
          ))}
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              loading={mutation.isPending}
              disabled={errors.length > 0 || busy}
            >
              Reject
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DecisionSection() {
  const { view, busy } = useReview();
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const c = view.commitment;

  let body: React.ReactNode;
  if (!c) {
    body = (
      <p className="text-sm text-muted-foreground">
        Save the details first; the decision is made on the commitment they
        create.
      </p>
    );
  } else if (c.status === "PENDING") {
    const decidable = view.packet.stage === "AWAITING_REVIEW";
    body = (
      <div className="flex flex-col gap-3">
        <Summary
          rows={[
            { label: "Committed", value: formatCents(c.committedCents) },
            { label: "Held (received)", value: formatCents(c.heldCents) },
            {
              label: "Decide by",
              value: c.effectiveDecisionDeadline
                ? formatDateOnly(c.effectiveDecisionDeadline)
                : "—",
            },
          ]}
        />
        {decidable ? (
          <Allow subject="commitments" action="update">
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => setAcceptOpen(true)}>
                Accept or reduce
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRejectOpen(true)}
              >
                Reject
              </Button>
            </div>
            <AcceptDialog open={acceptOpen} onOpenChange={setAcceptOpen} />
            <RejectDialog open={rejectOpen} onOpenChange={setRejectOpen} />
          </Allow>
        ) : null}
      </div>
    );
  } else if (c.status === "REJECTED") {
    body = (
      <Summary
        rows={[
          { label: "Status", value: "Rejected" },
          {
            label: "Decided on",
            value: c.acceptedOn ? formatDateOnly(c.acceptedOn) : "—",
          },
          { label: "Reason", value: c.rejectionReason ?? "—" },
          {
            label: "Refund due",
            value:
              c.refundDueCents > 0
                ? `${formatCents(c.refundDueCents)}${
                    c.refundDueBy ? ` by ${formatDateOnly(c.refundDueBy)}` : ""
                  }`
                : formatCents(0),
          },
          {
            label: "Refund still outstanding",
            value: formatCents(c.refundOutstandingCents),
          },
        ]}
      />
    );
  } else {
    body = (
      <Summary
        rows={[
          {
            label: "Status",
            value: c.status === "REDUCED" ? "Accepted (reduced)" : "Accepted",
          },
          {
            label: "Accepted on",
            value: c.acceptedOn ? formatDateOnly(c.acceptedOn) : "—",
          },
          { label: "Committed", value: formatCents(c.committedCents) },
          { label: "Accepted amount", value: formatCents(c.acceptedCents) },
          { label: "Capital paid", value: formatCents(c.capitalCents) },
          { label: "Preferred Units issued", value: trimUnits(c.units) },
          {
            label: "Balance outstanding",
            value: formatCents(c.outstandingBalanceCents),
          },
          {
            label: "Refund due",
            value:
              c.refundDueCents > 0
                ? `${formatCents(c.refundDueCents)}${
                    c.refundDueBy ? ` by ${formatDateOnly(c.refundDueBy)}` : ""
                  } (outstanding ${formatCents(c.refundOutstandingCents)})`
                : formatCents(0),
          },
        ]}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Decision</CardTitle>
        <CardDescription>
          Accept, reduce or reject within 10 business days of the signature and
          the initial installment (Section 4.8).
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
