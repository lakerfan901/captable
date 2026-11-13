"use client";

import { Fragment } from "react";
import { IsoDateText, Money } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";
import { LoanPaymentDialog } from "./loan-payment-dialog";
import { FUNDING_SOURCE_LABELS, labelOf } from "./shared";

export type LoanList = RouterOutputs["llcFinancials"]["loan"]["list"];

function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function LoanTable({
  data,
  canCreate,
  today,
}: {
  data: LoanList;
  canCreate: boolean;
  today: string;
}) {
  if (data.loans.length === 0) {
    return <p className="text-sm text-muted-foreground">No member loans.</p>;
  }
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lender</TableHead>
            <TableHead>Made on</TableHead>
            <TableHead>Maturity</TableHead>
            <TableHead>Rate</TableHead>
            <TableHead className="text-right">Principal</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead className="text-right">Accrued interest</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.loans.map((loan) => (
            <Fragment key={loan.id}>
              <TableRow>
                <TableCell className="font-medium">
                  {loan.lenderName ?? "—"}
                </TableCell>
                <TableCell>
                  <IsoDateText date={loan.madeOn} />
                </TableCell>
                <TableCell>
                  <IsoDateText date={loan.maturityOn} />
                  {loan.state?.pastMaturity &&
                  (loan.state.principalOutstanding ?? 0) > 0 ? (
                    <Badge variant="destructive" className="ml-2">
                      past maturity
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{bpsToPercent(loan.interestBps)}</TableCell>
                <TableCell className="text-right">
                  <Money cents={loan.principalCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={loan.state?.principalOutstanding ?? null} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={loan.state?.accruedInterest ?? null} />
                </TableCell>
                <TableCell className="text-right">
                  {canCreate && (loan.state?.principalOutstanding ?? 0) > 0 ? (
                    <LoanPaymentDialog
                      loanId={loan.id}
                      lenderName={loan.lenderName}
                      today={today}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
              {loan.payments.map((p) => (
                <TableRow key={p.id} className="text-xs text-muted-foreground">
                  <TableCell />
                  <TableCell colSpan={3}>
                    Payment <IsoDateText date={p.paidOn} /> from{" "}
                    {labelOf(FUNDING_SOURCE_LABELS, p.fundingSource)}
                  </TableCell>
                  <TableCell className="text-right">
                    principal <Money cents={p.principalCents} />
                  </TableCell>
                  <TableCell />
                  <TableCell className="text-right">
                    interest <Money cents={p.interestCents} />
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
