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
  labelOf,
  MANAGER_PAYMENT_CATEGORY_LABELS,
  ReversedBadge,
  struckClass,
} from "./shared";

export type ManagerPaymentList =
  RouterOutputs["llcFinancials"]["managerPayment"]["list"];

export function ManagerPaymentTable({
  data,
  canReverse,
}: {
  data: ManagerPaymentList;
  canReverse: boolean;
}) {
  const router = useRouter();
  const reverse = api.llcFinancials.managerPayment.reverse.useMutation({
    onSuccess: () => {
      toast.success("Manager payment reversed.");
      router.refresh();
    },
  });

  if (data.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Manager payments in this period.
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Paid on</TableHead>
            <TableHead>Payee</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Linked expense</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className={struckClass(row)}>
                <IsoDateText date={row.paidOn} />
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
                {labelOf(MANAGER_PAYMENT_CATEGORY_LABELS, row.category)}
                {row.countsTowardOrgCap ? (
                  <Badge variant="info" className="ml-2">
                    Section 6.21
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className={struckClass(row)}>
                {row.expense
                  ? labelOf(EXPENSE_CATEGORY_LABELS, row.expense.category)
                  : "—"}
              </TableCell>
              <TableCell className={`text-right ${struckClass(row)}`}>
                <Money cents={row.amountCents} />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <ReversedBadge row={row} />
                  {canReverse && !row.isReversal && !row.reversed ? (
                    <ReverseDialog
                      id={row.id}
                      title="Reverse Manager payment"
                      description={
                        row.expense
                          ? "A reversal entry dated today cancels this payment and its linked expense; all entries stay on the record."
                          : undefined
                      }
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
            <TableCell colSpan={4}>Total</TableCell>
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
