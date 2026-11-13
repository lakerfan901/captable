"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { addDays, quarterOf } from "@/lib/llc/dates";
import { cn } from "@/lib/utils";
import type { DistributionTypeValue } from "./distribution-table";
import type {
  DistributionInputsValue,
  DraftValue,
} from "./distribution-wizard";

const TYPES: { type: DistributionTypeValue; title: string; text: string }[] = [
  {
    type: "OPERATING",
    title: "Operating",
    text: "Available Cash, Section 5.6(c)–(e).",
  },
  {
    type: "RETURN_OF_UNUSED_CAPITAL",
    title: "Return of unused capital",
    text: "Section 1.15, straight to 5.6(d).",
  },
  {
    type: "SALE_OR_LIQUIDATION",
    title: "Sale or liquidation",
    text: "Section 5.6(f) / 11.4.",
  },
];

/** The last eight calendar quarters up to the one containing `today`, newest first. */
function recentQuarters(today: string) {
  const out: ReturnType<typeof quarterOf>[] = [];
  let q = quarterOf(today);
  for (let i = 0; i < 8; i++) {
    out.push(q);
    q = quarterOf(addDays(q.start, -1));
  }
  return out;
}

/** Last day of the month before the month containing `d`. */
function previousMonthEnd(d: string): string {
  return addDays(`${d.slice(0, 8)}01`, -1);
}

const EMPTY_LIQUIDATION = {
  cashAvailableCents: 0,
  windDownReserveCents: 0,
  creditors: [],
  isFinal: false,
};

export function StepSetup({
  today,
  draft,
  saving,
  error,
  onSave,
}: {
  today: string;
  draft: DraftValue | null;
  saving: boolean;
  error: string | null;
  onSave: (v: Omit<DraftValue, "id">) => void;
}) {
  const quarters = recentQuarters(today);
  const defaultQuarter = quarters[1] ?? quarters[0];
  const [type, setType] = useState<DistributionTypeValue>(
    draft?.type ?? "OPERATING",
  );
  const [quarterEnd, setQuarterEnd] = useState<string>(
    draft?.type === "OPERATING"
      ? draft.periodEnd
      : (defaultQuarter?.end ?? today),
  );
  const [paymentDate, setPaymentDate] = useState(draft?.paymentDate ?? today);
  const [saleEnd, setSaleEnd] = useState(
    draft?.type === "SALE_OR_LIQUIDATION"
      ? draft.periodEnd
      : previousMonthEnd(today),
  );
  const [liquidation, setLiquidation] = useState(
    draft?.inputs.type === "SALE_OR_LIQUIDATION" &&
      draft.inputs.liquidation !== null,
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const quarterOptions = quarters.some((q) => q.end === quarterEnd)
    ? quarters
    : [quarterOf(quarterEnd), ...quarters];

  const save = () => {
    setLocalError(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      setLocalError("Enter the payment date.");
      return;
    }
    const prev = draft?.inputs;
    let inputs: DistributionInputsValue;
    let periodStart: string | null = null;
    let periodEnd: string;
    if (type === "OPERATING") {
      const q = quarterOf(quarterEnd);
      periodStart = q.start;
      periodEnd = q.end;
      inputs = { type };
    } else if (type === "RETURN_OF_UNUSED_CAPITAL") {
      periodEnd = paymentDate;
      inputs = {
        type,
        amountCents:
          prev?.type === "RETURN_OF_UNUSED_CAPITAL" ? prev.amountCents : 0,
      };
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(saleEnd)) {
        setLocalError("Enter the period end.");
        return;
      }
      periodEnd = saleEnd;
      const prevLiq =
        prev?.type === "SALE_OR_LIQUIDATION" ? prev.liquidation : null;
      inputs = {
        type,
        liquidation: liquidation ? (prevLiq ?? EMPTY_LIQUIDATION) : null,
      };
    }
    onSave({
      type,
      periodStart,
      periodEnd,
      paymentDate,
      inputs,
      notes: draft?.notes ?? null,
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="grid gap-3 md:grid-cols-3">
        {TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => setType(t.type)}
            aria-pressed={type === t.type}
            className={cn(
              "rounded-lg border p-4 text-left transition-colors",
              type === t.type
                ? "border-teal-500 ring-1 ring-teal-500"
                : "hover:border-gray-400",
            )}
          >
            <div className="font-medium">{t.title}</div>
            <div className="text-sm text-muted-foreground">{t.text}</div>
          </button>
        ))}
      </div>

      {type === "OPERATING" ? (
        <div className="grid max-w-sm gap-2">
          <Label>Quarter</Label>
          <Select value={quarterEnd} onValueChange={setQuarterEnd}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {quarterOptions.map((q) => (
                <SelectItem key={q.end} value={q.end}>
                  Q{q.quarter} {q.year} ({q.start} to {q.end})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Available Cash is measured cumulatively through the quarter end.
          </p>
        </div>
      ) : null}

      {type === "SALE_OR_LIQUIDATION" ? (
        <div className="grid max-w-sm gap-4">
          <div className="flex items-center gap-3">
            <Switch
              id="liquidation"
              checked={liquidation}
              onCheckedChange={setLiquidation}
            />
            <Label htmlFor="liquidation">Liquidation under Section 11.4</Label>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sale-end">Period end</Label>
            <Input
              id="sale-end"
              type="date"
              value={saleEnd}
              onChange={(e) => setSaleEnd(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {liquidation
                ? "The date the worksheet figures are measured through."
                : "Available Cash is measured at a month end; choose the last day of a month on or before the payment date."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid max-w-sm gap-2">
        <Label htmlFor="payment-date">Payment date</Label>
        <Input
          id="payment-date"
          type="date"
          value={paymentDate}
          onChange={(e) => setPaymentDate(e.target.value)}
        />
      </div>

      {localError || error ? (
        <p className="text-sm text-destructive">{localError ?? error}</p>
      ) : null}

      <div>
        <Button onClick={save} loading={saving} disabled={saving}>
          Save and continue
        </Button>
      </div>
    </div>
  );
}
