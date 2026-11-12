"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NumericFormat } from "react-number-format";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  defaultKeepCents,
  type HeldReceipt,
  heldOnOrBefore,
  type OfferingTerms,
  planAcceptance,
  prefReturnStartDate,
  requiredInitialInstallmentCents,
  validateAcceptance,
} from "@/lib/admission/commitment-rules";
import {
  formatDateOnly,
  isValidDateOnly,
  todayInTimeZone,
} from "@/lib/date-only";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import { unitsForAmount } from "@/lib/llc/units";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import { useEntity } from "@/providers/entity-provider";
import { trimUnits } from "@/server/llc/serialize";
import { api } from "@/trpc/react";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";

/** The rules module's offering terms from the wire shape of a unit class. */
export function termsFromUnitClass(c: UnitClassDTO): OfferingTerms {
  const big = (n: number | null) => (n === null ? null : BigInt(n));
  return {
    minCommitmentCents: big(c.minCommitmentCents),
    minCommitmentFloorCents: big(c.minCommitmentFloorCents),
    offeringCapCents: big(c.offeringCapCents),
    initialInstallmentBps: c.initialInstallmentBps,
    finalClosingDate: c.finalClosingDate,
    balanceOutsideDate: c.balanceOutsideDate,
    acceptanceBusinessDays: c.acceptanceBusinessDays,
    refundBusinessDays: c.refundBusinessDays,
    prefReturnBps: c.prefReturnBps,
    balanceReturnStartRule: c.balanceReturnStartRule,
  };
}

/** Non-void receipts of a commitment in the rules module's shape. */
export function liveHeldReceipts(c: CommitmentDTO): HeldReceipt[] {
  return c.receipts
    .filter((r) => !r.voided)
    .map((r) => ({
      id: r.id,
      receivedOn: r.receivedOn,
      amountCents: BigInt(r.amountCents),
    }));
}

/** Dollar text as typed ("1234.5") → cents; null when empty or invalid. */
export function centsFromText(text: string): bigint | null {
  return text.trim() === "" ? null : parseDollarsToCents(text);
}

/** Cents → the unformatted dollar text a NumericFormat input holds. */
export function textFromCents(cents: bigint | number): string {
  const c = BigInt(cents);
  return `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
}

export function DollarInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <NumericFormat
      id={id}
      customInput={Input}
      thousandSeparator
      decimalScale={2}
      allowNegative={false}
      prefix="$"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onValueChange={(v) => onChange(v.value)}
    />
  );
}

type Preview = {
  errors: string[];
  notes: string[];
  rows: { label: string; value: string }[];
};

function computePreview(input: {
  commitment: CommitmentDTO;
  unitClass: UnitClassDTO;
  acceptedCents: bigint;
  keepCents: bigint | null;
  acceptedOn: string;
  minimumWaived: boolean;
  otherAcceptedCents: bigint;
  today: string;
}): Preview & { defaultKeep: bigint } {
  const { commitment: c, unitClass } = input;
  const terms = termsFromUnitClass(unitClass);
  const receipts = liveHeldReceipts(c);
  const committed = BigInt(c.committedCents);
  const accepted = input.acceptedCents;
  const total = receipts.reduce((sum, r) => sum + r.amountCents, 0n);
  // Only receipts dated on or before the acceptance date are the Initial
  // Installment (the server uses the same function).
  const held = heldOnOrBefore(receipts, input.acceptedOn);
  const later = receipts.filter((r) => r.receivedOn > input.acceptedOn);
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
  const keep = input.keepCents ?? defaultKeep;
  // bigint: Math.min does not apply.
  let max = accepted;
  if (held < max) max = held;

  const errors = validateAcceptance({
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

  const notes: string[] = [];
  if (later.length > 0) {
    const laterTotal = later.reduce((sum, r) => sum + r.amountCents, 0n);
    notes.push(
      `${formatCents(laterTotal)} received after ${formatDateOnly(input.acceptedOn)} does not count toward the Initial Installment; it will be applied as Balance payments on the dates received.`,
    );
  }

  const rows = [
    { label: "Required initial installment", value: formatCents(required) },
    {
      label: `Received on or before ${formatDateOnly(input.acceptedOn)}`,
      value: formatCents(held),
    },
    { label: "Total received", value: formatCents(total) },
  ];

  if (errors.length === 0 && accepted > 0n) {
    const plan = planAcceptance({
      receipts,
      acceptedOn: input.acceptedOn,
      acceptedCents: accepted,
      keepCents: keep,
    });
    const price = unitClass.pricePerUnitCents;
    let micro = 0n;
    let unitsKnown = price !== null && price > 0;
    for (const row of plan.rows) {
      if (row.appliedCents <= 0n) continue;
      if (unitsKnown && price !== null) {
        micro += microUnitsFromDecimal(
          unitsForAmount(
            row.appliedCents,
            BigInt(price),
            unitClass.fractionalUnitsAllowed,
          ),
        );
      } else {
        unitsKnown = false;
      }
      if (row.kind === "BALANCE") {
        const receipt = receipts.find((r) => r.id === row.id);
        const start = prefReturnStartDate({
          kind: "BALANCE",
          receivedOn: receipt?.receivedOn ?? input.acceptedOn,
          dueDate: null,
          terms,
        });
        if (start === undefined) {
          errors.push(
            "Set the Balance outside date of the unit class first (a receipt is dated after the acceptance date).",
          );
          break;
        }
      }
    }
    if (!unitsKnown) {
      errors.push("Set the price per unit of the unit class first.");
    }
    const applied = plan.rows.reduce((sum, r) => sum + r.appliedCents, 0n);
    rows.push(
      { label: "Amount kept (Initial Installment)", value: formatCents(keep) },
      { label: "Applied as capital", value: formatCents(applied) },
      { label: "Refund due", value: formatCents(plan.refundCents) },
      {
        label: "Units to be issued",
        value: unitsKnown ? trimUnits(microUnitsToDecimalString(micro)) : "—",
      },
      {
        label: "Balance after acceptance",
        value: formatCents(accepted - applied),
      },
    );
    if (keep !== defaultKeep) {
      notes.push(
        `Default (pro rata) amount kept: ${formatCents(defaultKeep)}.`,
      );
    }
  }
  if (held >= required && max >= required) {
    notes.push(
      `The amount kept may be between ${formatCents(required)} and ${formatCents(max)}; default ${formatCents(defaultKeep)} (pro rata).`,
    );
  }

  return { errors, notes, rows, defaultKeep };
}

export function DecideCommitmentDialog({
  commitment,
  unitClass,
  otherAcceptedCents,
  open,
  onOpenChange,
}: {
  commitment: CommitmentDTO;
  /** The commitment's (PREFERRED) unit class; null when missing. */
  unitClass: UnitClassDTO | null;
  /** Σ acceptedCents of the class's other ACCEPTED/REDUCED commitments. */
  otherAcceptedCents: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { timezone } = useEntity();
  const today = todayInTimeZone(timezone);

  const [acceptedOn, setAcceptedOn] = useState(today);
  const [mode, setMode] = useState<"full" | "reduce">("full");
  const [reducedText, setReducedText] = useState("");
  const [keepText, setKeepText] = useState("");
  const [minimumWaived, setMinimumWaived] = useState(false);
  const [waiverNote, setWaiverNote] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAcceptedOn(today);
      setMode("full");
      setReducedText("");
      setKeepText("");
      setMinimumWaived(false);
      setWaiverNote("");
      setServerError(null);
    }
  }, [open, today]);

  const { mutateAsync, isPending } = api.commitment.accept.useMutation({
    onSuccess: () => {
      toast.success("Commitment accepted.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => {
      setServerError(error.message);
      toast.error(error.message);
    },
  });

  const committed = BigInt(commitment.committedCents);
  const acceptedCents =
    mode === "full" ? committed : (centsFromText(reducedText) ?? 0n);
  const keepCents = centsFromText(keepText);
  const dateValid = isValidDateOnly(acceptedOn);
  const minimum = unitClass?.minCommitmentCents ?? null;
  const showWaiver =
    !commitment.isReplacement &&
    minimum !== null &&
    acceptedCents < BigInt(minimum);

  const preview =
    unitClass && dateValid
      ? computePreview({
          commitment,
          unitClass,
          acceptedCents,
          keepCents,
          acceptedOn,
          minimumWaived: showWaiver && minimumWaived,
          otherAcceptedCents: BigInt(otherAcceptedCents),
          today,
        })
      : null;
  const errors = !unitClass
    ? ["The company has no Preferred unit class."]
    : !dateValid
      ? ["Enter the acceptance date."]
      : (preview?.errors ?? []);
  if (keepText.trim() !== "" && keepCents === null) {
    errors.push("Enter the amount kept in dollars and cents.");
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (errors.length > 0) return;
    setServerError(null);
    await mutateAsync({
      id: commitment.id,
      acceptedOn,
      acceptedCents: mode === "full" ? undefined : Number(acceptedCents),
      keepCents: keepCents === null ? undefined : Number(keepCents),
      minimumWaived: showWaiver ? minimumWaived : undefined,
      minimumWaiverNote:
        showWaiver && minimumWaived && waiverNote.trim()
          ? waiverNote.trim()
          : undefined,
    }).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Accept or reduce</DialogTitle>
          <DialogDescription>
            {formatCents(commitment.committedCents)} committed by{" "}
            {commitment.stakeholderName}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="acceptedOn">Acceptance date</Label>
            <Input
              id="acceptedOn"
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
              <RadioGroupItem value="full" id="mode-full" />
              <Label htmlFor="mode-full">
                Accept in full ({formatCents(commitment.committedCents)})
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="reduce" id="mode-reduce" />
              <Label htmlFor="mode-reduce">Reduce to</Label>
            </div>
          </RadioGroup>
          {mode === "reduce" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="reducedTo">Accepted amount</Label>
              <DollarInput
                id="reducedTo"
                value={reducedText}
                onChange={(v) => {
                  setReducedText(v);
                  setKeepText("");
                }}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="keep">Amount kept</Label>
            <DollarInput
              id="keep"
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
                  id="waiver"
                  checked={minimumWaived}
                  onCheckedChange={(v) => setMinimumWaived(v === true)}
                />
                <Label htmlFor="waiver">
                  Waive the {formatCents(minimum ?? 0)} minimum (Section 3.7)
                </Label>
              </div>
              {minimumWaived ? (
                <Textarea
                  placeholder="Waiver note"
                  value={waiverNote}
                  onChange={(e) => setWaiverNote(e.target.value)}
                />
              ) : null}
            </div>
          ) : null}
          {preview ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
              {preview.rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="text-right tabular-nums">{row.value}</dd>
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
          {serverError ? (
            <p className="text-sm text-red-600">{serverError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              loading={isPending}
              disabled={errors.length > 0}
            >
              {mode === "full" ? "Accept" : "Accept reduced amount"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
