"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  confirmDiscard,
  useUnsavedChangesGuard,
} from "@/hooks/use-unsaved-changes-guard";
import { AvailableCashCard } from "../../financials/components/available-cash-card";
import type {
  DistributionInputsValue,
  DraftValue,
} from "./distribution-wizard";
import type { Computation } from "./lines-table";
import {
  type LiquidationDraft,
  LiquidationWorksheet,
} from "./liquidation-worksheet";

export function StepInputs({
  draft,
  computation,
  companyBase,
  unpaidFee,
  saving,
  saveError,
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
  /** The last save's error (shown next to Continue). */
  saveError: string | null;
  recalculating: boolean;
  onRecalculate: () => void;
  /**
   * Saves the inputs; resolves true when saved. With `thenReview` the wizard
   * goes on to the review step after the save. null hides the save buttons
   * and makes the inputs read-only (no `distributions: create`).
   */
  onSaveInputs:
    | ((
        inputs: DistributionInputsValue,
        opts?: { thenReview?: boolean },
      ) => Promise<boolean>)
    | null;
  setupHref: string;
  onContinue: () => void;
}) {
  const inputs = draft.inputs;
  const readOnly = onSaveInputs === null;
  const [amount, setAmount] = useState<number | null>(
    inputs.type === "RETURN_OF_UNUSED_CAPITAL" ? inputs.amountCents : null,
  );
  const [liquidation, setLiquidation] = useState<{
    draft: LiquidationDraft;
    dirty: boolean;
  } | null>(null);
  const onLiquidationChange = useCallback(
    (d: LiquidationDraft, dirty: boolean) =>
      setLiquidation({ draft: d, dirty }),
    [],
  );
  const [continueError, setContinueError] = useState<string | null>(null);

  // What "Continue" has to save first: the inputs as shown, when they differ
  // from the saved draft (continuing used to drop them silently).
  let pending:
    | { dirty: false }
    | { dirty: true; inputs: DistributionInputsValue }
    | { dirty: true; error: string } = { dirty: false };
  if (!readOnly) {
    if (inputs.type === "RETURN_OF_UNUSED_CAPITAL") {
      if ((amount ?? 0) !== inputs.amountCents) {
        pending = {
          dirty: true,
          inputs: {
            type: "RETURN_OF_UNUSED_CAPITAL",
            amountCents: amount ?? 0,
          },
        };
      }
    } else if (inputs.type === "SALE_OR_LIQUIDATION" && liquidation?.dirty) {
      pending = liquidation.draft.ok
        ? {
            dirty: true,
            inputs: {
              type: "SALE_OR_LIQUIDATION",
              liquidation: liquidation.draft.value,
            },
          }
        : { dirty: true, error: liquidation.draft.error };
    }
  }
  useUnsavedChangesGuard(pending.dirty);

  const continueToReview = async () => {
    setContinueError(null);
    if (!pending.dirty) {
      onContinue();
      return;
    }
    if ("error" in pending) {
      setContinueError(pending.error);
      return;
    }
    // Saves first; a failed save stops here (its error is shown below).
    await onSaveInputs?.(pending.inputs, { thenReview: true });
  };
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
                  void onSaveInputs({
                    type: "SALE_OR_LIQUIDATION",
                    liquidation,
                  })
              : null
          }
          onDraftChange={onLiquidationChange}
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
                disabled={readOnly}
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
                    void onSaveInputs({
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

      {pending.dirty ? (
        <p className="text-sm font-medium text-amber-700" role="status">
          You have unsaved changes. Continuing saves them first.
        </p>
      ) : null}
      {continueError || (pending.dirty && saveError) ? (
        <p className="text-sm text-destructive" role="alert">
          {continueError ?? saveError}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" asChild>
          <Link
            href={setupHref}
            onClick={(e) => {
              if (!confirmDiscard(pending.dirty)) e.preventDefault();
            }}
          >
            Back
          </Link>
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onRecalculate}
            loading={recalculating}
            disabled={pending.dirty}
            title={
              pending.dirty
                ? "Recalculate uses the saved inputs: save your changes first."
                : undefined
            }
          >
            Recalculate
          </Button>
          <Button
            onClick={() => void continueToReview()}
            disabled={(!computation && !pending.dirty) || saving}
            loading={saving}
          >
            {pending.dirty
              ? "Save and continue to review"
              : "Continue to review"}
          </Button>
        </div>
      </div>
    </div>
  );
}
