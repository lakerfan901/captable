"use client";

import { useEffect, useState } from "react";
import { Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Computation } from "./lines-table";

export interface CreditorValue {
  payee: string;
  amountCents: number;
  memo: string;
  managerCategory: "MANAGEMENT_FEE" | "EXPENSE_REIMBURSEMENT" | null;
}

export interface LiquidationValue {
  cashAvailableCents: number;
  windDownReserveCents: number;
  creditors: CreditorValue[];
  isFinal: boolean;
}

const FEE_PAYEE = "Accrued and unpaid Management Fee";

/** Initial creditor rows: the saved ones, or the Management Fee row prefilled with the unpaid fee. */
function initialCreditors(
  saved: CreditorValue[],
  unpaidFee: number | null,
): CreditorValue[] {
  if (saved.length > 0) return saved;
  return [
    {
      payee: FEE_PAYEE,
      amountCents: unpaidFee ?? 0,
      memo: "Section 11.4(a)",
      managerCategory: "MANAGEMENT_FEE",
    },
  ];
}

/** The worksheet as the server would receive it, or why it cannot be saved. */
export type LiquidationDraft =
  | { ok: true; value: LiquidationValue }
  | { ok: false; error: string };

/** The same normalisation `save` applies: blank rows dropped, payees trimmed. */
export function buildLiquidation(i: {
  cash: number | null;
  reserve: number | null;
  rows: CreditorValue[];
  isFinal: boolean;
}): LiquidationDraft {
  const kept = i.rows.filter((r) => r.payee.trim() !== "" || r.amountCents > 0);
  if (kept.some((r) => r.payee.trim() === "")) {
    return { ok: false, error: "Every creditor row needs a payee." };
  }
  return {
    ok: true,
    value: {
      cashAvailableCents: i.cash ?? 0,
      windDownReserveCents: i.reserve ?? 0,
      creditors: kept.map((r) => ({ ...r, payee: r.payee.trim() })),
      isFinal: i.isFinal,
    },
  };
}

/** True when the worksheet as shown differs from the saved one (an invalid worksheet always does). */
export function liquidationDiffers(
  draft: LiquidationDraft,
  saved: LiquidationValue,
): boolean {
  if (!draft.ok) return true;
  const a = draft.value;
  return (
    a.cashAvailableCents !== saved.cashAvailableCents ||
    a.windDownReserveCents !== saved.windDownReserveCents ||
    a.isFinal !== saved.isFinal ||
    a.creditors.length !== saved.creditors.length ||
    a.creditors.some((r, i) => {
      const b = saved.creditors[i];
      return (
        b === undefined ||
        r.payee !== b.payee ||
        r.amountCents !== b.amountCents ||
        r.memo !== b.memo ||
        r.managerCategory !== b.managerCategory
      );
    })
  );
}

/** Section 11.4 worksheet: cash, creditors, member loans (read-only), wind-down reserve, net to Members. */
export function LiquidationWorksheet({
  value,
  unpaidFee,
  computation,
  saving,
  onSave,
  onDraftChange,
}: {
  value: LiquidationValue;
  unpaidFee: number | null;
  computation: Computation | undefined;
  saving: boolean;
  /** null hides the save button and makes the worksheet read-only (no `distributions: create`). */
  onSave: ((v: LiquidationValue) => void) | null;
  /** The worksheet as shown and whether it differs from the saved one. */
  onDraftChange?: (draft: LiquidationDraft, dirty: boolean) => void;
}) {
  const readOnly = onSave === null;
  const [cash, setCash] = useState<number | null>(value.cashAvailableCents);
  const [reserve, setReserve] = useState<number | null>(
    value.windDownReserveCents,
  );
  const [isFinal, setIsFinal] = useState(value.isFinal);
  // A read-only viewer sees the saved creditors only (no unsaved prefill).
  const [rows, setRows] = useState<CreditorValue[]>(() =>
    readOnly ? value.creditors : initialCreditors(value.creditors, unpaidFee),
  );
  const [error, setError] = useState<string | null>(null);

  const liq = computation?.liquidation ?? null;
  const names = new Map(
    (computation?.lines ?? []).map((l) => [l.stakeholderId, l.name]),
  );
  const creditorsTotal = rows.reduce((s, r) => s + r.amountCents, 0);
  const loansTotal = liq?.memberLoans ?? 0;

  const update = (i: number, patch: Partial<CreditorValue>) =>
    setRows((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const draft = buildLiquidation({ cash, reserve, rows, isFinal });
  const dirty = !readOnly && liquidationDiffers(draft, value);
  // Reported on every change so "Continue" can save what is shown first.
  const draftKey = JSON.stringify(draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey stands for draft
  useEffect(() => {
    onDraftChange?.(draft, dirty);
  }, [draftKey, dirty, onDraftChange]);

  const save = () => {
    setError(null);
    if (!draft.ok) {
      setError(draft.error);
      return;
    }
    onSave?.(draft.value);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Liquidation worksheet (Section 11.4)
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div className="grid max-w-sm gap-2">
          <Label htmlFor="liq-cash">Cash available</Label>
          <MoneyInput
            id="liq-cash"
            value={cash}
            onChange={setCash}
            disabled={readOnly}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="font-medium">
            Creditors (Section 11.4(a)), including the Manager
          </div>
          {rows.map((r, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
              key={i}
              className="grid gap-2 md:grid-cols-[2fr_1fr_2fr_auto]"
            >
              <Input
                aria-label="Payee"
                placeholder="Payee"
                disabled={readOnly}
                value={r.payee}
                onChange={(e) => update(i, { payee: e.target.value })}
              />
              <MoneyInput
                aria-label="Amount"
                disabled={readOnly}
                value={r.amountCents}
                onChange={(c) => update(i, { amountCents: c ?? 0 })}
              />
              <Input
                aria-label="Memo"
                placeholder="Memo"
                disabled={readOnly}
                value={r.memo}
                onChange={(e) => update(i, { memo: e.target.value })}
              />
              {readOnly ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setRows((p) => p.filter((_, idx) => idx !== i))
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          <div className={readOnly ? "hidden" : undefined}>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((p) => [
                  ...p,
                  {
                    payee: "",
                    amountCents: 0,
                    memo: "",
                    managerCategory: null,
                  },
                ])
              }
            >
              Add creditor
            </Button>
          </div>
          <div className="flex justify-between border-t pt-2">
            <span>Total creditors</span>
            <Money cents={creditorsTotal} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="font-medium">
            Member loans paid in full (Section 11.4(b))
          </div>
          {liq === null ? (
            <p className="text-muted-foreground">
              Shown after the worksheet is saved.
            </p>
          ) : liq.loanPayments.length === 0 ? (
            <p className="text-muted-foreground">
              No member loans outstanding.
            </p>
          ) : (
            liq.loanPayments.map((l) => (
              <div key={l.loanId} className="flex justify-between">
                <span>
                  {names.get(l.lenderStakeholderId) ?? "Member"}: principal{" "}
                  <Money cents={l.principal} />, interest{" "}
                  <Money cents={l.interest} />
                </span>
                <Money cents={l.principal + l.interest} />
              </div>
            ))
          )}
          <div className="flex justify-between border-t pt-2">
            <span>Total member loans</span>
            <Money cents={loansTotal} />
          </div>
        </div>

        <div className="grid max-w-sm gap-2">
          <Label htmlFor="liq-reserve">Wind-down reserve</Label>
          <MoneyInput
            id="liq-reserve"
            value={reserve}
            onChange={setReserve}
            disabled={readOnly}
          />
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="liq-final"
            checked={isFinal}
            disabled={readOnly}
            onCheckedChange={(v) => setIsFinal(v === true)}
          />
          <Label htmlFor="liq-final" className="font-normal">
            Final distribution
          </Label>
        </div>

        <div className="flex justify-between border-t pt-2 font-semibold">
          <span>Net to Members (as last saved)</span>
          <Money cents={liq?.netToMembers ?? null} />
        </div>

        {error ? <p className="text-destructive">{error}</p> : null}
        {dirty ? (
          <p className="font-medium text-amber-700" role="status">
            Unsaved changes. Net to Members and the review use the worksheet as
            last saved until you save.
          </p>
        ) : null}
        {onSave ? (
          <div>
            <Button onClick={save} loading={saving} disabled={saving}>
              Save and recalculate
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
