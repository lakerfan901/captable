"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
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
  FUNDING_SOURCE_LABELS,
  labelOf,
  RESERVE_KIND_LABELS,
  ReversedBadge,
  struckClass,
} from "./shared";

export type ReserveRows =
  RouterOutputs["llcFinancials"]["reserve"]["list"]["rows"];
export type ReserveBalances =
  RouterOutputs["llcFinancials"]["reserve"]["balances"];

/** Balance per reserve and the pool it sits in. */
export function ReserveBalanceTable({
  balances,
}: {
  balances: ReserveBalances;
}) {
  const kinds = Object.entries(balances.byKind);
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reserve</TableHead>
            <TableHead className="text-right">From operating cash</TableHead>
            <TableHead className="text-right">
              From capital contributions
            </TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {kinds.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                No reserves established.
              </TableCell>
            </TableRow>
          ) : (
            kinds.map(([kind, b]) => (
              <TableRow key={kind}>
                <TableCell>{labelOf(RESERVE_KIND_LABELS, kind)}</TableCell>
                <TableCell className="text-right">
                  <Money cents={b.operating} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={b.capital} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={b.total} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell className="text-right">
              <Money cents={balances.operating} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={balances.capital} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={balances.total} />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

export function ReserveTable({
  rows,
  canReverse,
}: {
  rows: ReserveRows;
  canReverse: boolean;
}) {
  const router = useRouter();
  const reverse = api.llcFinancials.reserve.reverse.useMutation({
    onSuccess: () => {
      toast.success("Reserve entry reversed.");
      router.refresh();
    },
  });

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No reserve entries in this period.
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Effective</TableHead>
            <TableHead>Reserve</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Pool</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const crossPool =
              row.type === "RELEASE" &&
              row.releaseTo !== null &&
              row.releaseTo !== row.fundingSource;
            return (
              <TableRow key={row.id}>
                <TableCell className={struckClass(row)}>
                  <IsoDateText date={row.effectiveOn} />
                </TableCell>
                <TableCell className={struckClass(row)}>
                  {labelOf(RESERVE_KIND_LABELS, row.kind)}
                </TableCell>
                <TableCell className={struckClass(row)}>
                  {row.type === "ESTABLISH" ? "Established" : "Released"}
                </TableCell>
                <TableCell className={struckClass(row)}>
                  {labelOf(FUNDING_SOURCE_LABELS, row.fundingSource)}
                  {row.type === "RELEASE" && row.releaseTo !== null ? (
                    <> → {labelOf(FUNDING_SOURCE_LABELS, row.releaseTo)}</>
                  ) : null}
                </TableCell>
                <TableCell className={`text-right ${struckClass(row)}`}>
                  <Money cents={row.amountCents} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <ReversedBadge row={row} />
                    {crossPool && !row.isReversal ? (
                      <span className="text-xs text-muted-foreground">
                        Released into the other pool: cannot be reversed.
                        Establish the reserve again from the pool that received
                        the cash.
                      </span>
                    ) : null}
                    {canReverse &&
                    !crossPool &&
                    !row.isReversal &&
                    !row.reversed ? (
                      <ReverseDialog
                        id={row.id}
                        title="Reverse reserve entry"
                        onReverse={(input) => reverse.mutateAsync(input)}
                      />
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
