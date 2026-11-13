"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { ReverseDialog } from "./reverse-dialog";
import {
  EXPENSE_CATEGORY_LABELS,
  FUNDING_SOURCE_LABELS,
  labelOf,
  ReversedBadge,
  struckClass,
} from "./shared";

export type ExpenseList = RouterOutputs["llcFinancials"]["expense"]["list"];

export function ExpenseTable({
  data,
  canReverse,
}: {
  data: ExpenseList;
  canReverse: boolean;
}) {
  const router = useRouter();
  const reverse = api.llcFinancials.expense.reverse.useMutation({
    onSuccess: () => {
      toast.success("Expense reversed.");
      router.refresh();
    },
  });

  if (data.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No expenses in this period.
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Payee</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Paid from</TableHead>
            <TableHead>Section 6.21</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className={struckClass(row)}>
                <IsoDateText date={row.incurredOn} />
              </TableCell>
              <TableCell className={struckClass(row)}>
                {row.payee}
                {row.memo ? (
                  <div className="text-xs text-muted-foreground">
                    {row.memo}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className={struckClass(row)}>
                {labelOf(EXPENSE_CATEGORY_LABELS, row.category)}
              </TableCell>
              <TableCell className={struckClass(row)}>
                {labelOf(FUNDING_SOURCE_LABELS, row.fundingSource)}
              </TableCell>
              <TableCell>
                {row.countsTowardOrgCap ? (
                  <Badge variant="info">counted</Badge>
                ) : null}
              </TableCell>
              <TableCell className={`text-right ${struckClass(row)}`}>
                <Money cents={row.amountCents} />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <ReversedBadge row={row} />
                  {row.managerPaymentId !== null &&
                  !row.isReversal &&
                  !row.reversed ? (
                    <span className="text-xs text-muted-foreground">
                      Reverse through the Manager payment
                    </span>
                  ) : null}
                  {canReverse &&
                  !row.isReversal &&
                  !row.reversed &&
                  row.managerPaymentId === null ? (
                    <ReverseDialog
                      id={row.id}
                      title="Reverse expense"
                      onReverse={(input) => reverse.mutateAsync(input)}
                    />
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={5}>Total</TableCell>
            <TableCell className="text-right">
              <Money cents={data.totals.total} />
            </TableCell>
            <TableCell />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
