"use client";

import { IsoDateText, Money } from "@/components/llc/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";
import { ADVANCE_KIND_LABELS, labelOf } from "./shared";

export type AdvanceList = RouterOutputs["llcFinancials"]["advance"]["list"];

/** Outstanding tax advances per member, then advances and recoveries in [from, to]. */
export function AdvanceTable({
  data,
  from,
  to,
}: {
  data: AdvanceList;
  from: string;
  to: string;
}) {
  const names = new Map(data.outstanding.map((o) => [o.stakeholderId, o.name]));
  const inRange = (d: string) => d >= from && d <= to;
  const entries = [
    ...data.advances
      .filter((a) => inRange(a.paidOn))
      .map((a) => ({
        id: a.id,
        on: a.paidOn,
        stakeholderId: a.stakeholderId,
        what: `Advance — ${labelOf(ADVANCE_KIND_LABELS, a.kind)}${a.taxYear ? ` ${a.taxYear}` : ""}${a.jurisdiction ? ` (${a.jurisdiction})` : ""}`,
        amount: a.amountCents,
      })),
    ...data.recoveries
      .filter((r) => inRange(r.recoveredOn))
      .map((r) => ({
        id: r.id,
        on: r.recoveredOn,
        stakeholderId: r.stakeholderId,
        what:
          r.source === "CASH_REPAYMENT"
            ? "Repaid in cash"
            : "Recovered from a distribution",
        amount: -r.amountCents,
      })),
  ].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));

  return (
    <div className="grid gap-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.outstanding.length === 0 ? (
              <TableRow>
                <TableCell colSpan={2} className="text-muted-foreground">
                  No tax advances.
                </TableCell>
              </TableRow>
            ) : (
              data.outstanding.map((o) => (
                <TableRow key={o.stakeholderId}>
                  <TableCell>{o.name ?? o.stakeholderId}</TableCell>
                  <TableCell className="text-right">
                    <Money cents={o.amount} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tax advances or repayments in this period.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <IsoDateText date={e.on} />
                  </TableCell>
                  <TableCell>
                    {names.get(e.stakeholderId) ?? e.stakeholderId}
                  </TableCell>
                  <TableCell>{e.what}</TableCell>
                  <TableCell className="text-right">
                    <Money cents={e.amount} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
