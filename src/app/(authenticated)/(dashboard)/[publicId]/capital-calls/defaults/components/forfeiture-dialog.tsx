"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money, Units } from "@/components/llc/money";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fromDateOnly } from "@/lib/date-only";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

export type DefaultViewWire = RouterOutputs["memberDefault"]["get"]["view"];

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** R38: the server recomputed the proposal and it no longer matches what was shown. */
export function isConflict(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { data?: { code?: string } | null }).data?.code === "CONFLICT"
  );
}

export const CONFLICT_MESSAGE =
  "The figures changed since this screen was loaded (for example a payment or funding recorded elsewhere). The new figures are shown; review them again before confirming.";

/** "January 27, 2027". */
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    dateStyle: "long",
  }).format(fromDateOnly(iso));
}

/** Required checkbox shown before every confirm button. */
export function ReviewCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <Label htmlFor={id}>I have reviewed this computation</Label>
    </div>
  );
}

/** A button that may be disabled with an explanatory tooltip (wrapped so the tooltip fires while disabled). */
export function ActionButton({
  label,
  disabledReason,
  onClick,
  variant = "default",
}: {
  label: string;
  disabledReason: string | null;
  onClick: () => void;
  variant?: "default" | "destructive" | "outline";
}) {
  if (disabledReason === null) {
    return (
      <Button variant={variant} onClick={onClick}>
        {label}
      </Button>
    );
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable wrapper so the tooltip shows on a disabled button */}
          <span tabIndex={0}>
            <Button variant={variant} disabled className="pointer-events-none">
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** R33/R34: confirm the forfeiture computed for the Forfeiture Date. */
export function ForfeitureDialog({
  view,
  available,
}: {
  view: DefaultViewWire;
  available: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.confirmForfeiture.useMutation();
  const p = view.forfeiture.proposal;

  const submit = async () => {
    if (!p) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        id: view.id,
        expectedForfeitedCents: p.forfeited,
        expectedUnitsAfter: p.unitsAfter,
      });
      toast.success("Forfeiture confirmed.");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setReviewed(false);
      setError(isConflict(e) ? CONFLICT_MESSAGE : errorMessage(e));
      router.refresh();
    }
  };

  return (
    <>
      <ActionButton
        label="Confirm forfeiture"
        variant="destructive"
        disabledReason={
          available ? null : `Available after ${longDate(view.forfeitureDate)}`
        }
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setReviewed(false);
            setError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm forfeiture: {view.memberName}</DialogTitle>
            <DialogDescription>
              Effective on the Forfeiture Date,{" "}
              <IsoDateText date={view.forfeitureDate} />. This removes units and
              capital from the member and cannot be reversed by a later payment.
            </DialogDescription>
          </DialogHeader>
          {p ? (
            <div className="grid gap-3 text-sm">
              <blockquote className="border-l-2 pl-3 text-muted-foreground">
                Section 4.9(iv): &quot;if the default is not cured within five
                (5) business days after the due date (the &apos;Forfeiture
                Date&apos;), the Defaulting Member forfeits, as liquidated
                damages and not as a penalty, an amount equal to fifty percent
                (50%) of its unpaid Balance on the Forfeiture Date, but not more
                than the Capital Contributions it has paid (the &apos;Forfeited
                Amount&apos;).&quot;
              </blockquote>
              <ul className="grid gap-1 rounded border p-3">
                <li>
                  Unpaid Balance on the Forfeiture Date:{" "}
                  <Money cents={p.unpaidAtForfeiture} />
                </li>
                <li>
                  50% × <Money cents={p.unpaidAtForfeiture} /> ={" "}
                  <Money cents={p.halfOfUnpaid} />; cap{" "}
                  <Money cents={p.capitalPaid} /> (Capital Contributions paid)
                  {p.capBinding ? " — the cap applies" : ""}
                </li>
                <li className="font-medium">
                  Forfeited Amount <Money cents={p.forfeited} />
                </li>
                <li>
                  Preferred Units <Units micro={p.unitsBefore} /> →{" "}
                  <Units micro={p.unitsAfter} />
                </li>
                <li>
                  Unreturned Capital Contributions reduced by{" "}
                  <Money cents={p.unreturnedDeducted} />; Capital Contributions
                  after <Money cents={p.contributedAfter} />
                </li>
                <li>
                  Accrued Preferred Return extinguished{" "}
                  <Money cents={p.extinguishedReturn} />
                </li>
              </ul>
              {p.forfeited === 0 ? (
                <Alert>
                  <AlertDescription>
                    The Forfeited Amount is $0.00. Confirming still records the
                    forfeiture step.
                  </AlertDescription>
                </Alert>
              ) : null}
              <p className="text-muted-foreground">
                The Forfeited Amount is held in suspense until the Credit Date
                and then credited to other holders (confirmed separately).
              </p>
              <ReviewCheckbox
                id={`ff-review-${view.id}`}
                checked={reviewed}
                onChange={setReviewed}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No forfeiture proposal is available now.
            </p>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            {p ? (
              <Button
                variant="destructive"
                onClick={submit}
                loading={mutation.isPending}
                disabled={mutation.isPending || !reviewed}
              >
                Confirm forfeiture of <Money cents={p.forfeited} />
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
