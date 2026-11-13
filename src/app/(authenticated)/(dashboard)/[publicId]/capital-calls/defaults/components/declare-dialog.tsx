"use client";

import { useParams, useRouter } from "next/navigation";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";
import { errorMessage } from "./forfeiture-dialog";
import type { OverdueLine } from "./overdue-table";

/** R30–R33: declaring is the Manager's decision; requires typing the member's name. */
export function DeclareDialog({ line }: { line: OverdueLine }) {
  const router = useRouter();
  const params = useParams<{ publicId: string }>();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = api.memberDefault.declare.useMutation();
  const confirmed = typed.trim() === line.name.trim();

  const submit = async () => {
    setError(null);
    try {
      const r = await mutation.mutateAsync({
        callNoticeLineId: line.lineId,
        expectedUnpaidCents: line.unpaidAtDue,
      });
      toast.success(`Default declared for ${line.name}.`);
      setOpen(false);
      router.push(`/${params.publicId}/capital-calls/defaults/${r.id}`);
    } catch (e) {
      setTyped("");
      setError(errorMessage(e));
      router.refresh();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Declare default
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Declare default: {line.name}</DialogTitle>
          <DialogDescription>
            Call Notice No. {line.callNoticeNumber}, due{" "}
            <IsoDateText date={line.dueOn} />.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <dl className="grid grid-cols-2 gap-1 rounded border p-3">
            <dt>Amount called</dt>
            <dd className="text-right">
              <Money cents={line.amountCalled} />
            </dd>
            <dt className="font-medium">Unpaid at the due date</dt>
            <dd className="text-right font-medium">
              <Money cents={line.unpaidAtDue} />
            </dd>
            <dt>Outstanding today</dt>
            <dd className="text-right">
              <Money cents={line.outstanding} />
            </dd>
            <dt>Interest to date (12% p.a.)</dt>
            <dd className="text-right">
              <Money cents={line.interestToDate} />
            </dd>
            <dt>Forfeiture Date</dt>
            <dd className="text-right">
              <IsoDateText date={line.forfeitureDate} />
            </dd>
            <dt>Replacement Funder window</dt>
            <dd className="text-right">
              <IsoDateText date={line.replacementWindow.opensOn} /> –{" "}
              <IsoDateText date={line.replacementWindow.closesOn} />
            </dd>
          </dl>
          <div className="grid gap-1 text-muted-foreground">
            <p>Consequences under Section 4.9 of the Operating Agreement:</p>
            <ul className="list-disc pl-5">
              <li>
                (i) the unpaid amount bears interest at 12% per annum from the
                due date until paid;
              </li>
              <li>
                (ii) from the first business day after the due date the Manager
                may offer the unpaid Balance to Replacement Funders, and the
                member&apos;s commitment is reduced by any amount so funded;
              </li>
              <li>
                (iii) while the default continues the member&apos;s Preferred
                Units do not vote, and distributions on them are withheld and
                applied to the unpaid Balance, interest and costs;
              </li>
              <li>
                (iv) if not cured by the Forfeiture Date, the member forfeits
                50% of its unpaid Balance on that date, capped at the Capital
                Contributions it has paid (confirmed separately).
              </li>
            </ul>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`declare-${line.lineId}`}>
              Type the member&apos;s name ({line.name}) to confirm
            </Label>
            <Input
              id={`declare-${line.lineId}`}
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={submit}
            loading={mutation.isPending}
            disabled={mutation.isPending || !confirmed}
          >
            Declare default
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
