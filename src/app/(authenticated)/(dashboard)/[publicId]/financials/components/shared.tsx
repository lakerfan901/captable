"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import type {
  ExpenseCategoryEnum,
  FundingSourceEnum,
  ManagerPaymentCategoryEnum,
  MemberAdvanceKindEnum,
  ReserveKindEnum,
} from "@/prisma/enums";

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategoryEnum, string> = {
  COLOCATION: "Colocation",
  POWER: "Power",
  NETWORK: "Network",
  INSURANCE: "Insurance",
  REPAIR_AND_REPLACEMENT: "Repair and replacement",
  SOFTWARE_AND_SUPPORT: "Software and support",
  PROFESSIONAL_FEES: "Professional fees",
  TAXES_AND_FILING_FEES: "Taxes and filing fees",
  BANK_FEES: "Bank fees",
  ORGANIZATIONAL_OFFERING: "Organizational and offering (Section 6.21)",
  EQUIPMENT_ACQUISITION: "Equipment acquisition",
  DEFAULT_COLLECTION: "Default collection",
  OTHER: "Other",
};

export const FUNDING_SOURCE_LABELS: Record<FundingSourceEnum, string> = {
  OPERATING_CASH: "Operating cash",
  CAPITAL_CONTRIBUTIONS: "Capital contributions",
};

export const MANAGER_PAYMENT_CATEGORY_LABELS: Record<
  ManagerPaymentCategoryEnum,
  string
> = {
  MANAGEMENT_FEE: "Management Fee",
  EXPENSE_REIMBURSEMENT: "Expense reimbursement",
  PURCHASING_AGENT_PASS_THROUGH: "Purchasing agent pass-through",
  OTHER: "Other",
};

export const RESERVE_KIND_LABELS: Record<ReserveKindEnum, string> = {
  MINIMUM_OPERATING: "Minimum operating",
  ANTICIPATED_EXPENSES: "Anticipated expenses",
  LIABILITIES: "Liabilities",
  EQUIPMENT_REPAIR_AND_REPLACEMENT: "Equipment repair and replacement",
  COLOCATION_DEPOSITS: "Colocation deposits",
  INSURANCE_DEDUCTIBLES: "Insurance deductibles",
  TAXES: "Taxes",
  WORKING_CAPITAL: "Working capital",
  WIND_DOWN: "Wind-down",
};

export const ADVANCE_KIND_LABELS: Record<MemberAdvanceKindEnum, string> = {
  TAX_WITHHOLDING: "Tax withholding",
  COMPOSITE_RETURN: "Composite return",
  ENTITY_LEVEL_TAX: "Entity-level tax",
  IMPUTED_UNDERPAYMENT: "Imputed underpayment",
};

export function labelOf(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key;
}

const TABS = [
  { name: "Summary", path: "" },
  { name: "Revenue", path: "/revenue" },
  { name: "Expenses", path: "/expenses" },
  { name: "Manager payments", path: "/manager-payments" },
  { name: "Reserves", path: "/reserves" },
  { name: "Loans & advances", path: "/loans-advances" },
] as const;

/** Tab bar of the financials section (layout.tsx). */
export function FinancialsTabs({ publicId }: { publicId: string }) {
  const pathname = usePathname();
  const base = `/${publicId}/financials`;
  return (
    <nav className="flex flex-wrap gap-1 border-b">
      {TABS.map((tab) => {
        const href = `${base}${tab.path}`;
        const active =
          tab.path === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={tab.name}
            href={href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              active
                ? "border-primary font-semibold text-primary"
                : "border-transparent text-gray-600 hover:text-primary",
            )}
          >
            {tab.name}
          </Link>
        );
      })}
    </nav>
  );
}

/** From/to date filter kept in the URL (`?from=YYYY-MM-DD&to=YYYY-MM-DD`). */
export function DateRangeFilter({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (f === "" || t === "") return;
        router.push(`${pathname}?from=${f}&to=${t}`);
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="range-from">From</Label>
        <Input
          id="range-from"
          type="date"
          value={f}
          onChange={(e) => setF(e.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="range-to">To</Label>
        <Input
          id="range-to"
          type="date"
          value={t}
          onChange={(e) => setT(e.target.value)}
        />
      </div>
      <Button type="submit" variant="outline">
        Apply
      </Button>
    </form>
  );
}

/** Select over a closed enum, labelled from a label map. */
export function EnumSelect<K extends string>({
  value,
  onChange,
  labels,
  options,
  disabled,
  placeholder,
}: {
  value: K | undefined;
  onChange: (value: K) => void;
  labels: Record<K, string>;
  options?: readonly K[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const keys = options ?? (Object.keys(labels) as K[]);
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as K)}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? "Select"} />
      </SelectTrigger>
      <SelectContent>
        {keys.map((k) => (
          <SelectItem key={k} value={k}>
            {labels[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Select over `{ id, name }` options (stakeholders, documents). */
export function OptionSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: readonly { id: string; name: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? "Select"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Row style for immutable ledgers: reversal rows and reversed rows are struck through. */
export function struckClass(row: {
  isReversal: boolean;
  reversed: boolean;
}): string {
  return row.isReversal || row.reversed ? "line-through text-gray-500" : "";
}

export function ReversedBadge({
  row,
}: {
  row: { isReversal: boolean; reversed: boolean };
}) {
  if (!row.isReversal && !row.reversed) return null;
  return (
    <Badge variant="warning" title={row.isReversal ? "Reversal entry" : ""}>
      reversed
    </Badge>
  );
}

export type NamedOption = { id: string; name: string };

/** Labelled form field with an inline error. */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** First Zod issue message per top-level field. */
export function issuesByField(
  issues: readonly {
    path: readonly PropertyKey[];
    message: string;
  }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "_");
    out[key] ??= issue.message;
  }
  return out;
}

/** Form state for a ledger dialog: values, field errors, and a submit wrapper that shows server errors. */
export function useLedgerForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof T>(key: K, value: T[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const reset = () => {
    setValues(initial);
    setErrors({});
  };
  return { values, set, errors, setErrors, reset };
}
