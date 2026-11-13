"use client";

import { useState } from "react";
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

/** Section 11.4 worksheet: cash, creditors, member loans (read-only), wind-down reserve, net to Members. */
export function LiquidationWorksheet({
  value,
  unpaidFee,
  computation,
  saving,
  onSave,
}: {
  value: LiquidationValue;
  unpaidFee: number | null;
  computation: Computation | undefined;
  saving: boolean;
  /** null hides the save button (no `distributions: create`). */
  onSave: ((v: LiquidationValue) => void) | null;
}) {
  const [cash, setCash] = useState<number | null>(value.cashAvailableCents);
  const [reserve, setReserve] = useState<number | null>(
    value.windDownReserveCents,
  );
  const [isFinal, setIsFinal] = useState(value.isFinal);
  const [rows, setRows] = useState<CreditorValue[]>(() =>
    initialCreditors(value.creditors, unpaidFee),
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

  const save = () => {
    setError(null);
    const kept = rows.filter((r) => r.payee.trim() !== "" || r.amountCents > 0);
    if (kept.some((r) => r.payee.trim() === "")) {
      setError("Every creditor row needs a payee.");
      return;
    }
    onSave?.({
      cashAvailableCents: cash ?? 0,
      windDownReserveCents: reserve ?? 0,
      creditors: kept.map((r) => ({ ...r, payee: r.payee.trim() })),
      isFinal,
    });
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
          <MoneyInput id="liq-cash" value={cash} onChange={setCash} />
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
                value={r.payee}
                onChange={(e) => update(i, { payee: e.target.value })}
              />
              <MoneyInput
                aria-label="Amount"
                value={r.amountCents}
                onChange={(c) => update(i, { amountCents: c ?? 0 })}
              />
              <Input
                aria-label="Memo"
                placeholder="Memo"
                value={r.memo}
                onChange={(e) => update(i, { memo: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRows((p) => p.filter((_, idx) => idx !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
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
          <MoneyInput id="liq-reserve" value={reserve} onChange={setReserve} />
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="liq-final"
            checked={isFinal}
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
