"use client";

// The Reconciliation block of the release dialog (04-investor-portal.md
// P38, 6.3; package P16), between Checklist and Audience. Lists every
// ledger-derived figure of the draft that differs from the ledger, with
// "Refresh from ledger" (the editor's own action) when the dialog is given it.

import { RiCheckLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import {
  differencesSentence,
  type ReconcileBlock,
} from "@/lib/governance/release-reconcile-view";

export function ReconciliationBlock({
  block,
  onRefresh,
  refreshing,
}: {
  block: ReconcileBlock;
  /** absent: the user cannot refresh here (the sentence says what to do instead) */
  onRefresh?: () => void;
  refreshing: boolean;
}) {
  if (block.kind === "none") return null;
  return (
    <div className="space-y-2" data-testid="reconciliation">
      <h3 className="text-sm font-semibold tracking-tight">Reconciliation</h3>
      {block.kind === "loading" ? (
        <p className="text-sm text-muted-foreground">
          Checking the figures against the ledger…
        </p>
      ) : block.kind === "error" ? (
        <p className="text-sm text-muted-foreground">
          The figures could not be checked against the ledger now (
          {block.message}). Release checks them again and refuses if they
          differ.
        </p>
      ) : block.kind === "match" ? (
        <p className="flex items-center gap-2 text-sm">
          <RiCheckLine
            className="h-4 w-4 shrink-0 text-green-700"
            aria-hidden
          />
          Figures match the ledger.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium text-red-600">
            {differencesSentence(block.rows.length)} Release is not possible
            until they match.
          </p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">Figure</th>
                  <th className="px-3 py-1.5 text-right font-medium">
                    In the report
                  </th>
                  <th className="px-3 py-1.5 text-right font-medium">
                    In the ledger
                  </th>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((r) => (
                  <tr key={r.field} className="border-t">
                    <td className="px-3 py-1.5">{r.label}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                      {r.report}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                      {r.ledger}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {onRefresh ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onRefresh}
                loading={refreshing}
                disabled={refreshing}
              >
                Refresh from ledger
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">
              Refreshing replaces these figures with the ledger&rsquo;s and
              keeps the notes. Or correct the ledger, then open this dialog
              again.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
