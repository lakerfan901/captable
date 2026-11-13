"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/trpc/react";
import {
  ActionButton,
  CONFLICT_MESSAGE,
  type DefaultViewWire,
  errorMessage,
  isConflict,
  ReviewCheckbox,
} from "./forfeiture-dialog";

const METHOD: Record<"PAID_IN_FULL" | "REPLACEMENT_FUNDED", string> = {
  PAID_IN_FULL:
    "the Defaulting Member has paid its unpaid Balance with interest and costs",
  REPLACEMENT_FUNDED:
    "the unpaid Balance has been funded in full by Replacement Funders and the Forfeited Amount has been applied",
};

/** R37: mark the default cured as of the date the condition was first met. */
export function CureDialog({ view }: { view: DefaultViewWire }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.confirmCure.useMutation();
  const curedOn = view.cure.curedOn;

  const submit = async () => {
    if (curedOn === null) return;
    setError(null);
    try {
      await mutation.mutateAsync({ id: view.id, expectedCuredOn: curedOn });
      toast.success("Default marked cured.");
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
        label="Confirm cure"
        variant="outline"
        disabledReason={null}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm cure: {view.memberName}</DialogTitle>
            <DialogDescription>
              Suspension of the member&apos;s Preferred Units ends on the cure
              date.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <blockquote className="border-l-2 pl-3 text-muted-foreground">
              Section 4.9: &quot;A default is cured when the Defaulting Member
              has paid its unpaid Balance with interest and costs, or when the
              unpaid Balance has been funded in full by Replacement Funders and
              the Forfeited Amount has been applied under clause (iv).&quot;
            </blockquote>
            <ul className="grid gap-1 rounded border p-3">
              <li>
                Cured on: <IsoDateText date={curedOn} />
              </li>
              <li>
                Because: {view.cure.method ? METHOD[view.cure.method] : "—"}
              </li>
              <li>
                Outstanding Balance <Money cents={view.outstandingBalance} />
                {"; "}
                interest owed <Money cents={view.interestOwed} />; costs owed{" "}
                <Money cents={view.costsOwed} />
              </li>
            </ul>
            {view.interestOwed > 0 || view.costsOwed > 0 ? (
              <p className="text-muted-foreground">
                Interest and costs still owed stay owed after the cure and may
                be withheld from distributions (Section 4.9(v)).
              </p>
            ) : null}
            <ReviewCheckbox
              id={`cu-review-${view.id}`}
              checked={reviewed}
              onChange={setReviewed}
            />
            {error ? <p className="text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              loading={mutation.isPending}
              disabled={mutation.isPending || !reviewed || curedOn === null}
            >
              Confirm cure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
