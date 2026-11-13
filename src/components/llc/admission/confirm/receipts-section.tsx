"use client";

import { useState } from "react";
import { ReceiptTable } from "@/components/llc/commitment/receipt-table";
import { RecordReceiptDialog } from "@/components/llc/commitment/record-receipt-dialog";
import { Allow } from "@/components/rbac/allow";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { useReview } from "./review-context";

// Section 3 of the confirmation screen (F13): the wires received on the
// packet's commitment, recorded with the Commitments page's dialog
// (`commitment.recordReceipt`). The dialog reloads the page; the view is
// re-read after it closes so the next step sends the latest figures.

export function ReceiptsSection() {
  const { view, busy, reload } = useReview();
  const [open, setOpen] = useState(false);
  const c = view.commitment;

  if (!c) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Wire receipts</CardTitle>
          <CardDescription>
            Save the details first; wires are recorded against the commitment
            they create.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const canRecord =
    c.status !== "REJECTED" &&
    (view.packet.stage === "AWAITING_REVIEW" ||
      view.packet.stage === "AWAITING_COUNTERSIGN");
  const live = c.receipts.filter((r) => !r.voided);
  const received = live.reduce((sum, r) => sum + r.amountCents, 0);
  const paid = view.answers?.parsed.paidCents ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-base">Wire receipts</CardTitle>
          <CardDescription>
            {c.status === "PENDING"
              ? "Money received before the decision is held until the commitment is accepted or rejected."
              : "Receipts on this commitment."}
          </CardDescription>
        </div>
        {canRecord ? (
          <Allow subject="commitments" action="create">
            <Button disabled={busy} onClick={() => setOpen(true)}>
              Record wire
            </Button>
          </Allow>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-0">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 px-6 text-sm md:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Committed</dt>
            <dd className="tabular-nums">{formatCents(c.committedCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              Initial installment required (
              {view.classTerms.initialInstallmentBps / 100}%)
            </dt>
            <dd className="tabular-nums">
              {formatCents(c.requiredInitialCents)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Received</dt>
            <dd className="tabular-nums">{formatCents(received)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {c.status === "PENDING" ? "Decide by" : "Status"}
            </dt>
            <dd
              className={
                c.status === "PENDING" && c.decisionOverdue
                  ? "text-red-600"
                  : undefined
              }
            >
              {c.status === "PENDING"
                ? c.effectiveDecisionDeadline
                  ? formatDateOnly(c.effectiveDecisionDeadline)
                  : "the clock starts when the initial installment and signature are in"
                : c.status}
            </dd>
          </div>
        </dl>
        {paid !== null ? (
          <p className="px-6 text-sm text-muted-foreground">
            The investor wrote {formatCents(paid)} as paid with the signature
            page. Record only money that has arrived in the bank.
          </p>
        ) : null}
        {c.receipts.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            No wires recorded yet.
          </p>
        ) : (
          <ReceiptTable
            receipts={c.receipts.map((r) => ({
              ...r,
              stakeholderName: c.stakeholderName,
            }))}
          />
        )}
      </CardContent>
      <RecordReceiptDialog
        commitment={c}
        unitClass={view.classTerms}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // The dialog refreshes on success; re-read either way so `busy`
          // covers the reload.
          if (!next) reload();
        }}
      />
    </Card>
  );
}
