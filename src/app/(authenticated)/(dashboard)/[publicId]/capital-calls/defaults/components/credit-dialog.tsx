"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money, Units } from "@/components/llc/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/trpc/react";
import {
  ActionButton,
  CONFLICT_MESSAGE,
  type DefaultViewWire,
  errorMessage,
  isConflict,
  longDate,
  ReviewCheckbox,
} from "./forfeiture-dialog";

/** R35/R36: confirm the credit of the Forfeited Amount on the Credit Date. */
export function CreditDialog({
  view,
  available,
  availableOn,
  names,
}: {
  view: DefaultViewWire;
  available: boolean;
  availableOn: string | null;
  names: Record<string, string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.confirmCredit.useMutation();
  const p = view.credit.proposal;
  const creditDate = view.credit.creditDate;
  const nameOf = (id: string) =>
    names[id] ??
    view.fundings.find((f) => f.funderStakeholderId === id)?.funderName ??
    id;
  const insiderFundings = view.fundings.filter(
    (f) =>
      f.funderIsInsider && (creditDate === null || f.fundedOn <= creditDate),
  );

  const submit = async () => {
    if (!p || p.blocked) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        id: view.id,
        expectedPoolACents: p.poolA,
        expectedPoolBCents: p.poolB,
        expectedCreditDate: creditDate ?? undefined,
      });
      toast.success("Credit confirmed.");
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
        label="Confirm credit"
        disabledReason={
          available
            ? null
            : availableOn
              ? `Available on the Credit Date (${longDate(availableOn)}); it may move earlier if the Balance is fully funded by Replacement Funders`
              : "Not available"
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
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Confirm credit: {view.memberName}</DialogTitle>
            <DialogDescription>
              Credit Date <IsoDateText date={creditDate} />. Each credit is
              recorded as a Capital Contribution of the holder on that date and
              issues Preferred Units (fractional).
            </DialogDescription>
          </DialogHeader>
          <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
            Section 4.9(iv): &quot;(A) an amount equal to fifty percent (50%) of
            the Forfeited Amount multiplied by the fraction of the unpaid
            Balance funded by Replacement Funders on or before the Credit Date,
            to those Replacement Funders in proportion to the amounts each
            funded; and (B) the remainder, to all holders of Preferred Units
            other than the Defaulting Member, in proportion to the Preferred
            Units they held on the due date; provided that any amount that would
            be credited under clause (A) to the Manager, Isaac Reid, Karl
            Schoen, or any of their Affiliates is instead credited under clause
            (B).&quot;
          </blockquote>
          {!p ? (
            <p className="text-sm text-muted-foreground">
              No credit proposal is available now.
            </p>
          ) : p.blocked ? (
            <Alert variant="destructive">
              <AlertTitle>Cannot be confirmed</AlertTitle>
              <AlertDescription>
                No eligible holders on the due date — consult counsel
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-3 text-sm">
              <ul className="grid gap-1 rounded border p-3">
                <li>
                  Forfeited Amount{" "}
                  <Money cents={view.forfeiture.recorded?.forfeited} />; unpaid
                  Balance on the Forfeiture Date{" "}
                  <Money cents={view.forfeiture.recorded?.unpaidAtForfeiture} />
                </li>
                <li>
                  Funded by Replacement Funders on or before the Credit Date:{" "}
                  <Money cents={p.fundedCounted} />
                </li>
                <li>
                  Clause (A) pool: 50% ×{" "}
                  <Money cents={view.forfeiture.recorded?.forfeited} /> ×{" "}
                  <Money cents={p.fundedCounted} /> /{" "}
                  <Money cents={view.forfeiture.recorded?.unpaidAtForfeiture} />{" "}
                  (capped at 1) = <Money cents={p.poolA} />
                </li>
                <li>
                  Redirected from insiders to clause (B):{" "}
                  <Money cents={p.redirected} />
                  {insiderFundings.length > 0
                    ? ` (${[...new Set(insiderFundings.map((f) => f.funderName))].join(", ")})`
                    : ""}
                </li>
                <li className="font-medium">
                  Clause (B) pool: <Money cents={p.poolB} />
                </li>
              </ul>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Holder</TableHead>
                    <TableHead>Clause</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.credits.map((c) => (
                    <TableRow key={`${c.holderId}-${c.clause}`}>
                      <TableCell>{nameOf(c.holderId)}</TableCell>
                      <TableCell>{c.clause}</TableCell>
                      <TableCell className="text-right">
                        <Money cents={c.amount} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Units micro={c.units} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ReviewCheckbox
                id={`cr-review-${view.id}`}
                checked={reviewed}
                onChange={setReviewed}
              />
            </div>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            {p && !p.blocked ? (
              <Button
                onClick={submit}
                loading={mutation.isPending}
                disabled={mutation.isPending || !reviewed}
              >
                Confirm credit
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
