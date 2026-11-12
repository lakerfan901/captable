import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { MemberScheduleDTO } from "@/lib/admission/member-schedule";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";

type Indicators = MemberScheduleDTO["indicators"];

function closingLabel(i: Indicators): string | null {
  if (i.finalClosingDate === null || i.daysToFinalClosing === null) return null;
  const d = i.daysToFinalClosing;
  if (d > 0) return `${d} ${d === 1 ? "day" : "days"} left`;
  if (d === 0) return "Closes today";
  return `Closed on ${formatDateOnly(i.finalClosingDate)}`;
}

export function ScheduleIndicators({
  indicators: i,
  publicId,
}: {
  indicators: Indicators;
  publicId: string;
}) {
  const closing = closingLabel(i);
  const barPct =
    i.capUsedBps === null ? 0 : Math.min(100, Math.max(0, i.capUsedBps / 100));

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <Card className="p-4">
        <p className="text-xs text-muted-foreground">Committed vs cap</p>
        <p className="mt-1 text-sm font-medium">
          {formatCents(i.committedCents)}
          {i.capCents !== null ? ` of ${formatCents(i.capCents)}` : ""}
        </p>
        {i.capCents !== null ? (
          <>
            <div className="mt-2 h-2 w-full rounded bg-muted">
              <div
                className="h-2 rounded bg-primary"
                style={{ width: `${barPct}%` }}
              />
            </div>
            {i.remainingCents !== null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Remaining {formatCents(i.remainingCents)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Cap not set</p>
        )}
      </Card>

      <Card className="p-4">
        <p className="text-xs text-muted-foreground">Final Closing</p>
        {closing === null ? (
          <p className="mt-1 text-sm font-medium">
            Not set{" "}
            <Link
              href={`/${publicId}/unit-classes`}
              className="text-xs text-primary underline"
            >
              Unit classes
            </Link>
          </p>
        ) : (
          <p className="mt-1 text-sm font-medium">{closing}</p>
        )}
      </Card>

      <Card className="p-4">
        <p className="text-xs text-muted-foreground">Pending subscriptions</p>
        <p className="mt-1 text-sm font-medium">
          {i.pendingCount} pending{" "}
          {i.pendingCount === 1 ? "subscription" : "subscriptions"} (
          {formatCents(i.pendingCommittedCents)})
        </p>
        {i.overdueDecisions > 0 ? (
          <p className="mt-1 text-xs text-red-600">
            {i.overdueDecisions} past the decision deadline
          </p>
        ) : null}
      </Card>

      {i.refundsOutstandingCents > 0 ? (
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Refunds outstanding</p>
          <p className="mt-1 text-sm font-medium">
            {formatCents(i.refundsOutstandingCents)}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
