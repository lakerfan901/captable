"use client";

import Link from "next/link";
import { useState } from "react";
import { IsoDateText, Money } from "@/components/llc/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";
import type { Computation } from "./lines-table";

function isConflict(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { data?: { code?: string } | null }).data?.code === "CONFLICT"
  );
}

export const SOLVENCY_TEXT =
  "The LLC will be able to pay its debts as they come due and its assets will exceed its liabilities after this distribution (W.S. 17-29-405).";

export function StepFinalize({
  distributionId,
  computation: c,
  reviewHref,
  onFinalized,
  onConflict,
}: {
  distributionId: string;
  computation: Computation;
  reviewHref: string;
  onFinalized: () => void;
  onConflict: () => void;
}) {
  const [solvent, setSolvent] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = api.distribution.finalize.useMutation();
  const paid = c.lines.filter((l) => l.net > 0).length;
  const ready = solvent && typed.includes("FINALIZE") && !mutation.isPending;

  const finalize = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        id: distributionId,
        expectedHash: c.hash,
        solvencyConfirmed: true,
      });
      onFinalized();
    } catch (e) {
      if (isConflict(e)) {
        onConflict();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardContent className="grid gap-2 p-4 text-sm md:grid-cols-2">
          <div>
            Amount distributed:{" "}
            <Money className="font-semibold" cents={c.amount} />
          </div>
          <div>
            Net paid to members: <Money cents={c.totalNet} />
          </div>
          <div>
            Members paid: {paid} of {c.lines.length}
          </div>
          <div>
            Payment date: <IsoDateText date={c.paymentDate} />
          </div>
          <div>
            Default offsets: <Money cents={c.totalDefaultOffset} />
          </div>
          <div>
            Tax advances recovered: <Money cents={c.totalTaxOffset} />
          </div>
          <div className="md:col-span-2">
            Reserve balance to be reported (Section 5.6(a)):{" "}
            <Money cents={c.reserveBalance} />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2">
        <Checkbox
          id="solvency"
          checked={solvent}
          onCheckedChange={(v) => setSolvent(v === true)}
        />
        <Label htmlFor="solvency" className="text-sm font-normal leading-5">
          {SOLVENCY_TEXT}
        </Label>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="finalize-confirm">
          Type FINALIZE to confirm. Finalizing writes the ledger and cannot be
          edited afterwards; it can only be reversed.
        </Label>
        <Input
          id="finalize-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex justify-between">
        <Button variant="outline" asChild>
          <Link href={reviewHref}>Back to review</Link>
        </Button>
        <Button
          onClick={finalize}
          disabled={!ready}
          loading={mutation.isPending}
        >
          Finalize distribution
        </Button>
      </div>
    </div>
  );
}
