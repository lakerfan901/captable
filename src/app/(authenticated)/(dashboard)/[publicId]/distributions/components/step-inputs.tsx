"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { AvailableCashCard } from "../../financials/components/available-cash-card";
import type {
  DistributionInputsValue,
  DraftValue,
} from "./distribution-wizard";
import type { Computation } from "./lines-table";
import { LiquidationWorksheet } from "./liquidation-worksheet";

export function StepInputs({
  draft,
  computation,
  companyBase,
  unpaidFee,
  saving,
  recalculating,
  onRecalculate,
  onSaveInputs,
  setupHref,
  onContinue,
}: {
  draft: DraftValue;
  computation: Computation | undefined;
  companyBase: string;
  unpaidFee: number | null;
  saving: boolean;
  recalculating: boolean;
  onRecalculate: () => void;
  /** null hides the save buttons (no `distributions: create`). */
  onSaveInputs: ((inputs: DistributionInputsValue) => void) | null;
  setupHref: string;
  onContinue: () => void;
}) {
  const inputs = draft.inputs;
  const [amount, setAmount] = useState<number | null>(
    inputs.type === "RETURN_OF_UNUSED_CAPITAL" ? inputs.amountCents : null,
  );
  const unreturnedTotal = (computation?.lines ?? []).reduce(
    (s, l) => s + l.unreturnedBefore,
    0,
  );

  const fixLink = (label: string, path: string) => (
    <Link
      className="underline"
      href={`${companyBase}/${path}`}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      {inputs.type === "SALE_OR_LIQUIDATION" && inputs.liquidation !== null ? (
        <LiquidationWorksheet
          value={inputs.liquidation}
          unpaidFee={unpaidFee}
          computation={computation}
          saving={saving}
          onSave={
            onSaveInputs
              ? (liquidation) =>
                  onSaveInputs({ type: "SALE_OR_LIQUIDATION", liquidation })
              : null
          }
        />
      ) : inputs.type === "RETURN_OF_UNUSED_CAPITAL" ? (
        <Card className="max-w-xl">
          <CardContent className="flex flex-col gap-3 p-4 text-sm">
            <p>
              Unused capital available (Section 1.15):{" "}
              <Money
                className="font-semibold"
                cents={computation?.unusedCapital}
              />
            </p>
            <p>
              Total Unreturned Capital Contributions:{" "}
              <Money
                className="font-semibold"
                cents={computation ? unreturnedTotal : null}
              />
            </p>
            <div className="grid max-w-xs gap-2">
              <Label htmlFor="return-amount">Amount to return</Label>
              <MoneyInput
                id="return-amount"
                value={amount}
                onChange={setAmount}
              />
            </div>
            <p className="text-muted-foreground">
              The whole amount is paid under Section 5.6(d) in proportion to
              Unreturned Capital Contributions; no Preferred Return is paid.
            </p>
            {onSaveInputs ? (
              <div>
                <Button
                  onClick={() =>
                    onSaveInputs({
                      type: "RETURN_OF_UNUSED_CAPITAL",
                      amountCents: amount ?? 0,
                    })
                  }
                  loading={saving}
                  disabled={saving}
                >
                  Save and recalculate
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {computation?.availableCash ? (
            <AvailableCashCard
              className="max-w-2xl"
              availableCash={computation.availableCash}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Loading the Available Cash statement…
            </p>
          )}
          <p className="max-w-2xl text-sm">
            The amount distributed is the Available Cash shown. To hold cash
            back, establish a reserve (Section 5.6(a)).
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            {fixLink("Fix revenue", "financials/revenue")}
            {fixLink("Add expense", "financials/expenses")}
            {fixLink("Adjust reserves", "financials/reserves")}
          </div>
        </div>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" asChild>
          <Link href={setupHref}>Back</Link>
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onRecalculate}
            loading={recalculating}
          >
            Recalculate
          </Button>
          <Button onClick={onContinue} disabled={!computation}>
            Continue to review
          </Button>
        </div>
      </div>
    </div>
  );
}
