"use client";

// The status line of the team dashboard and the drift banner (6.3, P35,
// P39). `financialDashboard.status` recomputes the published months from the
// ledger, so it is fetched once per visit (never on focus) and again only
// after a Restate invalidates it.

import { useState } from "react";
import {
  driftSentence,
  monthLabel,
  statusLine,
} from "@/components/financials/team-dashboard-model";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";
import { RestateDialog } from "./restate-dialog";

export function DashboardStatus({ canRestate }: { canRestate: boolean }) {
  const status = api.financialDashboard.status.useQuery(undefined, {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [open, setOpen] = useState(false);

  if (status.error) {
    return (
      <p className="text-sm text-red-600" data-testid="status-line">
        The publication status could not be read: {status.error.message}
      </p>
    );
  }
  if (!status.data) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="status-line">
        Checking the published months against the ledger…
      </p>
    );
  }
  const s = status.data;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground" data-testid="status-line">
        {statusLine(s)}
      </p>
      {s.drift.length > 0 ? (
        <Alert variant="destructive" data-testid="drift-banner">
          <AlertTitle>{driftSentence(s.drift.length)}</AlertTitle>
          <AlertDescription>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-foreground">
                {s.drift.map((d) => monthLabel(d.month)).join(", ")}. Investors
                still see the figures published at release; the ledger now has
                other figures for{" "}
                {s.drift.length === 1 ? "this month" : "these months"}.
              </p>
              {canRestate ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-foreground"
                  onClick={() => setOpen(true)}
                >
                  Review and restate
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {open && canRestate ? (
        <RestateDialog drift={s.drift} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
