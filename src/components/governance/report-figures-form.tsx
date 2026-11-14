"use client";

import { useState } from "react";
import { NumericFormat } from "react-number-format";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant } from "@/lib/company-time";
import { formatDateOnly } from "@/lib/date-only";
import {
  MAX_NOTE_CHARS,
  type ReportFigures,
} from "@/lib/governance/report-figures";
import { formatCents } from "@/lib/money";

// Figures of a QUARTERLY / ANNUAL report draft (03-governance.md G13).
// Money is integer cents through `MoneyInput` (cents may be negative:
// reversals); utilization is a percent with two decimals stored as basis
// points, converted from the typed string (no float arithmetic).

/** "SOME_CATEGORY" → "Some category" (same rule as the report view). */
function humanizeCategory(category: string): string {
  if (!/^[A-Z0-9_]+$/.test(category)) return category;
  const words = category.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type MpLine = ReportFigures["managerPayments"]["lines"][number];

/** "82.5" → 8250; "" → null. Two decimals at most (NumericFormat). */
export function percentTextToBps(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  const bps = whole * 100 + frac;
  return Math.min(bps, 10_000);
}

export function bpsToPercentText(bps: number | null): string {
  if (bps === null) return "";
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
}

function Fieldset({
  legend,
  children,
  note,
  onNote,
  disabled,
}: {
  legend: string;
  children: React.ReactNode;
  note: string;
  onNote: (note: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      {children}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Note</Label>
        <Textarea
          rows={2}
          value={note}
          maxLength={MAX_NOTE_CHARS}
          disabled={disabled}
          onChange={(e) => onNote(e.target.value)}
        />
      </div>
    </fieldset>
  );
}

function Money({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (cents: number | null) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-center">
      <Label>{label}</Label>
      <MoneyInput
        allowNegative
        aria-label={label}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

const EMPTY_LINE: MpLine = {
  paidOn: "",
  payee: "",
  category: "",
  flow: "TO",
  amountCents: 0,
  memo: null,
  resolutionId: null,
};

function AddLineForm({
  onAdd,
  disabled,
}: {
  onAdd: (line: MpLine) => void;
  disabled: boolean;
}) {
  const [line, setLine] = useState<MpLine>(EMPTY_LINE);
  const [amount, setAmount] = useState<number | null>(null);
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(line.paidOn) &&
    line.payee.trim() !== "" &&
    line.category.trim() !== "" &&
    amount !== null;
  return (
    <div className="grid gap-2 rounded-md border border-dashed p-3 sm:grid-cols-6">
      <Input
        type="date"
        aria-label="Date"
        value={line.paidOn}
        disabled={disabled}
        onChange={(e) => setLine({ ...line, paidOn: e.target.value })}
      />
      <Input
        aria-label="Payee"
        placeholder="Payee"
        maxLength={200}
        value={line.payee}
        disabled={disabled}
        onChange={(e) => setLine({ ...line, payee: e.target.value })}
      />
      <Input
        aria-label="Purpose"
        placeholder="Purpose"
        maxLength={200}
        value={line.category}
        disabled={disabled}
        onChange={(e) => setLine({ ...line, category: e.target.value })}
      />
      <Select
        value={line.flow}
        disabled={disabled}
        onValueChange={(v) => setLine({ ...line, flow: v as MpLine["flow"] })}
      >
        <SelectTrigger aria-label="Flow">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="TO">To</SelectItem>
          <SelectItem value="THROUGH">Through</SelectItem>
        </SelectContent>
      </Select>
      <MoneyInput
        allowNegative
        aria-label="Amount"
        value={amount}
        disabled={disabled}
        onChange={setAmount}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !valid}
        onClick={() => {
          if (amount === null) return;
          onAdd({
            ...line,
            payee: line.payee.trim(),
            category: line.category.trim(),
            amountCents: amount,
          });
          setLine(EMPTY_LINE);
          setAmount(null);
        }}
      >
        Add line
      </Button>
    </div>
  );
}

export function ReportFiguresForm({
  type,
  figures,
  onChange,
  disabled,
  onRefresh,
  refreshing,
  timeZone,
}: {
  type: "QUARTERLY" | "ANNUAL";
  figures: ReportFigures;
  onChange: (next: ReportFigures) => void;
  disabled: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  /** Company time zone (the same text on the server and in the browser). */
  timeZone: string;
}) {
  const f = figures;
  const mp = f.managerPayments;
  // Lines added in this session can be removed again; the ones loaded from
  // the ledger (or saved earlier) are shown read-only.
  const [loadedLines] = useState(mp.lines.length);
  const set = <K extends keyof ReportFigures>(
    key: K,
    value: ReportFigures[K],
  ) => onChange({ ...f, [key]: value });
  const noPayments =
    mp.lines.length +
      mp.insiderDistributions.length +
      mp.insiderLoanPayments.length ===
    0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {f.source
            ? `From the ledger as of ${formatInstant(f.source.fetchedAt, timeZone)} (period ${formatDateOnly(f.source.periodStart)} – ${formatDateOnly(f.source.periodEnd)}).`
            : "Not loaded from the ledger yet."}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || refreshing}
          onClick={onRefresh}
        >
          {refreshing ? "Refreshing…" : "Refresh from ledger"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Refreshing keeps your notes and utilization but replaces every amount
        and the payment lines with the ledger's, including lines added here.
      </p>

      <Fieldset
        legend="Revenue"
        note={f.revenue.note}
        disabled={disabled}
        onNote={(note) => set("revenue", { ...f.revenue, note })}
      >
        <Money
          label="Gross Revenue"
          value={f.revenue.amountCents}
          disabled={disabled}
          onChange={(amountCents) =>
            set("revenue", { ...f.revenue, amountCents })
          }
        />
      </Fieldset>

      <Fieldset
        legend="Utilization"
        note={f.utilization.note}
        disabled={disabled}
        onNote={(note) => set("utilization", { ...f.utilization, note })}
      >
        <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-center">
          <Label>Average utilization for the period</Label>
          <NumericFormat
            customInput={Input}
            suffix="%"
            decimalScale={2}
            allowNegative={false}
            disabled={disabled}
            value={bpsToPercentText(f.utilization.bps)}
            isAllowed={({ value }) =>
              value === "" || (percentTextToBps(value) ?? 0) <= 10_000
            }
            onValueChange={({ value }) =>
              set("utilization", {
                ...f.utilization,
                bps: percentTextToBps(value),
              })
            }
          />
        </div>
      </Fieldset>

      <Fieldset
        legend="Expenses"
        note={f.expenses.note}
        disabled={disabled}
        onNote={(note) => set("expenses", { ...f.expenses, note })}
      >
        <Money
          label="Total expenses"
          value={f.expenses.totalCents}
          disabled={disabled}
          onChange={(totalCents) =>
            set("expenses", { ...f.expenses, totalCents })
          }
        />
        {f.expenses.lines.length > 0 ? (
          <ul className="space-y-1 pl-4 text-sm text-muted-foreground">
            {f.expenses.lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ledger lines, never reordered
              <li key={i} className="flex justify-between gap-4">
                <span>{humanizeCategory(l.category)}</span>
                <span className="tabular-nums">
                  {formatCents(l.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Fieldset>

      <Fieldset
        legend="Management Fee"
        note={f.managementFee.note}
        disabled={disabled}
        onNote={(note) => set("managementFee", { ...f.managementFee, note })}
      >
        <Money
          label="Accrued"
          value={f.managementFee.accruedCents}
          disabled={disabled}
          onChange={(accruedCents) =>
            set("managementFee", { ...f.managementFee, accruedCents })
          }
        />
        <Money
          label="Paid"
          value={f.managementFee.paidCents}
          disabled={disabled}
          onChange={(paidCents) =>
            set("managementFee", { ...f.managementFee, paidCents })
          }
        />
        <Money
          label="Unpaid at period end"
          value={f.managementFee.unpaidAtEndCents}
          disabled={disabled}
          onChange={(unpaidAtEndCents) =>
            set("managementFee", { ...f.managementFee, unpaidAtEndCents })
          }
        />
      </Fieldset>

      <Fieldset
        legend="Reserves"
        note={f.reserves.note}
        disabled={disabled}
        onNote={(note) => set("reserves", { ...f.reserves, note })}
      >
        <Money
          label="Reserve balance at period end"
          value={f.reserves.balanceCents}
          disabled={disabled}
          onChange={(balanceCents) =>
            set("reserves", { ...f.reserves, balanceCents })
          }
        />
        <Money
          label="Minimum required"
          value={f.reserves.minimumRequiredCents}
          disabled={disabled}
          onChange={(minimumRequiredCents) =>
            set("reserves", { ...f.reserves, minimumRequiredCents })
          }
        />
      </Fieldset>

      <Fieldset
        legend="Distributions"
        note={f.distributions.note}
        disabled={disabled}
        onNote={(note) => set("distributions", { ...f.distributions, note })}
      >
        <div className="flex items-center gap-2">
          <Checkbox
            id="no-distribution"
            checked={f.distributions.none}
            disabled={disabled}
            onCheckedChange={(v) =>
              set("distributions", { ...f.distributions, none: v === true })
            }
          />
          <Label htmlFor="no-distribution">
            {type === "QUARTERLY"
              ? "No distribution this quarter"
              : "No distribution this period"}
          </Label>
        </div>
        {f.distributions.none ? null : (
          <>
            <Money
              label="Total distributed"
              value={f.distributions.totalCents}
              disabled={disabled}
              onChange={(totalCents) =>
                set("distributions", { ...f.distributions, totalCents })
              }
            />
            <Money
              label="Preferred Return"
              value={f.distributions.preferredReturnCents}
              disabled={disabled}
              onChange={(preferredReturnCents) =>
                set("distributions", {
                  ...f.distributions,
                  preferredReturnCents,
                })
              }
            />
            <Money
              label="Return of capital"
              value={f.distributions.returnOfCapitalCents}
              disabled={disabled}
              onChange={(returnOfCapitalCents) =>
                set("distributions", {
                  ...f.distributions,
                  returnOfCapitalCents,
                })
              }
            />
            <Money
              label="Residual"
              value={f.distributions.residualCents}
              disabled={disabled}
              onChange={(residualCents) =>
                set("distributions", { ...f.distributions, residualCents })
              }
            />
          </>
        )}
      </Fieldset>

      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-semibold">
          Amounts paid to or through the Manager and its Affiliates
        </legend>
        {mp.lines.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-1 pr-2 font-medium">Date</th>
                  <th className="py-1 pr-2 font-medium">Payee</th>
                  <th className="py-1 pr-2 font-medium">Purpose</th>
                  <th className="py-1 pr-2 font-medium">Flow</th>
                  <th className="py-1 pr-2 text-right font-medium">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mp.lines.map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are appended or removed by index
                  <tr key={i} className="border-b last:border-b-0">
                    <td className="whitespace-nowrap py-1 pr-2">
                      {formatDateOnly(l.paidOn)}
                    </td>
                    <td className="py-1 pr-2">{l.payee}</td>
                    <td className="py-1 pr-2">
                      {humanizeCategory(l.category)}
                    </td>
                    <td className="py-1 pr-2">
                      {l.flow === "TO" ? "To" : "Through"}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {formatCents(l.amountCents)}
                    </td>
                    <td className="py-1 text-right">
                      {i >= loadedLines && !disabled ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            set("managerPayments", {
                              ...mp,
                              lines: mp.lines.filter((_, j) => j !== i),
                              grandTotalCents:
                                (mp.grandTotalCents ?? 0) - l.amountCents,
                            })
                          }
                        >
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {mp.insiderDistributions.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {mp.insiderDistributions.length} distribution(s) to the Manager, its
            Affiliates and related holders (from the ledger).
          </p>
        ) : null}
        {mp.insiderLoanPayments.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {mp.insiderLoanPayments.length} loan repayment(s) to them (from the
            ledger).
          </p>
        ) : null}
        {mp.grandTotalCents !== null ? (
          <p className="text-sm font-medium">
            Total: {formatCents(mp.grandTotalCents)}
          </p>
        ) : null}
        <AddLineForm
          disabled={disabled}
          onAdd={(line) =>
            set("managerPayments", {
              ...mp,
              lines: [...mp.lines, line],
              grandTotalCents: (mp.grandTotalCents ?? 0) + line.amountCents,
              confirmedNone: false,
            })
          }
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="mp-none"
            checked={mp.confirmedNone && noPayments}
            disabled={disabled || !noPayments}
            onCheckedChange={(v) =>
              set("managerPayments", { ...mp, confirmedNone: v === true })
            }
          />
          <Label htmlFor="mp-none">None in this period</Label>
        </div>
      </fieldset>
    </div>
  );
}
