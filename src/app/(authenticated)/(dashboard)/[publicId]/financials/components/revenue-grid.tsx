"use client";

import { RiLockLine } from "@remixicon/react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import { ZRevenueSaveSchema } from "@/trpc/routers/llc-financials/schema";
import type { RouterOutputs } from "@/trpc/shared";
import { Field, issuesByField } from "./shared";

export type RevenueYear = RouterOutputs["llcFinancials"]["revenue"]["list"];
type RevenueRow = RevenueYear["rows"][number];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthName(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

function bpsToPercentText(bps: number | null): string {
  return bps === null ? "—" : `${(bps / 100).toFixed(2)}%`;
}

export function RevenueYearSelect({
  year,
  years,
}: {
  year: number;
  years: number[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Select
      value={String(year)}
      onValueChange={(y) => router.push(`${pathname}?year=${y}`)}
    >
      <SelectTrigger className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {years.map((y) => (
          <SelectItem key={y} value={String(y)}>
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RevenueGrid({
  data,
  currentMonth,
  canEdit,
}: {
  data: RevenueYear;
  /** First day of the current month (YYYY-MM-01); later months are not editable. */
  currentMonth: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<RevenueRow | null>(null);
  const total = (f: (r: RevenueRow) => number) =>
    data.rows.reduce((acc, r) => acc + f(r), 0);

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Customer receipts</TableHead>
              <TableHead className="text-right">Pass-through fees</TableHead>
              <TableHead className="text-right">Gross Revenue</TableHead>
              <TableHead className="text-right">Management Fee 5%</TableHead>
              <TableHead className="text-right">Other income</TableHead>
              <TableHead className="text-right">Asset-sale proceeds</TableHead>
              <TableHead className="text-right">Insurance proceeds</TableHead>
              <TableHead className="text-right">Utilization</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => {
              const future = row.month > currentMonth;
              return (
                <TableRow
                  key={row.month}
                  className={row.saved ? "" : "text-muted-foreground"}
                >
                  <TableCell className="whitespace-nowrap">
                    {row.locked ? (
                      <RiLockLine
                        className="mr-1 inline h-4 w-4"
                        aria-label="Books closed"
                      />
                    ) : null}
                    {monthName(row.month)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={row.customerReceiptsCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={row.passThroughFeesCents} />
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <Money cents={row.grossRevenue} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={row.managementFeeCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={row.otherIncomeCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={row.assetSaleProceedsCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={row.insuranceProceedsCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    {bpsToPercentText(row.utilizationBps)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && !row.locked && !future ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(row)}
                      >
                        Edit
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total</TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.customerReceiptsCents)} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.passThroughFeesCents)} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.grossRevenue)} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.managementFeeCents)} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.otherIncomeCents)} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.assetSaleProceedsCents)} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={total((r) => r.insuranceProceedsCents)} />
              </TableCell>
              <TableCell />
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      {editing && !editing.locked ? (
        <RevenueMonthDialog
          key={editing.month}
          row={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function RevenueMonthDialog({
  row,
  onClose,
}: {
  row: RevenueRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [v, setV] = useState({
    customerReceiptsCents: row.customerReceiptsCents as number | null,
    passThroughFeesCents: row.passThroughFeesCents as number | null,
    otherIncomeCents: row.otherIncomeCents as number | null,
    assetSaleProceedsCents: row.assetSaleProceedsCents as number | null,
    insuranceProceedsCents: row.insuranceProceedsCents as number | null,
    utilizationPercent:
      row.utilizationBps === null ? "" : String(row.utilizationBps / 100),
    notes: row.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = api.llcFinancials.revenue.save.useMutation();
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) =>
    setV((s) => ({ ...s, [k]: value }));
  const gross = (v.customerReceiptsCents ?? 0) - (v.passThroughFeesCents ?? 0);

  const submit = async () => {
    const pct = Number(v.utilizationPercent);
    const parsed = ZRevenueSaveSchema.safeParse({
      month: row.month,
      customerReceiptsCents: v.customerReceiptsCents ?? 0,
      passThroughFeesCents: v.passThroughFeesCents ?? 0,
      otherIncomeCents: v.otherIncomeCents ?? 0,
      assetSaleProceedsCents: v.assetSaleProceedsCents ?? 0,
      insuranceProceedsCents: v.insuranceProceedsCents ?? 0,
      utilizationBps:
        v.utilizationPercent.trim() === ""
          ? null
          : Number.isNaN(pct)
            ? Number.NaN
            : Math.round(pct * 100),
      notes: v.notes.trim() === "" ? null : v.notes,
    });
    if (!parsed.success) {
      setErrors(issuesByField(parsed.error.issues));
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      toast.success(`Revenue for ${monthName(row.month)} saved.`);
      onClose();
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErrors({ _: message });
      toast.error(message);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Revenue — {monthName(row.month)}</DialogTitle>
          <DialogDescription>
            Cash actually received in the month. The Management Fee is computed
            on Gross Revenue (customer receipts less pass-through fees, Section
            6.18).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Customer receipts" error={errors.customerReceiptsCents}>
            <MoneyInput
              value={v.customerReceiptsCents}
              onChange={(c) => set("customerReceiptsCents", c)}
            />
          </Field>
          <Field
            label="Pass-through fees"
            error={errors.passThroughFeesCents}
            hint="Marketplace commissions, platform fees and payment-processing fees."
          >
            <MoneyInput
              value={v.passThroughFeesCents}
              onChange={(c) => set("passThroughFeesCents", c)}
            />
          </Field>
          <div className="text-sm sm:col-span-2">
            Gross Revenue: <Money cents={gross} />
          </div>
          <Field
            label="Other income (interest and other)"
            error={errors.otherIncomeCents}
          >
            <MoneyInput
              value={v.otherIncomeCents}
              onChange={(c) => set("otherIncomeCents", c)}
            />
          </Field>
          <Field
            label="Asset-sale proceeds"
            error={errors.assetSaleProceedsCents}
          >
            <MoneyInput
              value={v.assetSaleProceedsCents}
              onChange={(c) => set("assetSaleProceedsCents", c)}
            />
          </Field>
          <Field
            label="Insurance proceeds"
            error={errors.insuranceProceedsCents}
          >
            <MoneyInput
              value={v.insuranceProceedsCents}
              onChange={(c) => set("insuranceProceedsCents", c)}
            />
          </Field>
          <Field label="Utilization % (optional)" error={errors.utilizationBps}>
            <Input
              inputMode="decimal"
              value={v.utilizationPercent}
              onChange={(e) => set("utilizationPercent", e.target.value)}
            />
          </Field>
          <Field label="Notes" error={errors.notes} className="sm:col-span-2">
            <Textarea
              value={v.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
        {errors._ ? (
          <p className="text-sm text-destructive">{errors._}</p>
        ) : null}
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={mutation.isPending}
            loading={mutation.isPending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
