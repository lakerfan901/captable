import Link from "next/link";
import ActivitiesCard from "@/components/dashboard/overview/activities-card";
import EconomicsSlot from "@/components/llc/overview/economics-slot";
import { StatCard } from "@/components/llc/overview/stat-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { api } from "@/trpc/server";

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Display only: 125,000,000 cents → "$1.25M". */
function formatCentsCompact(cents: number): string {
  return compactUsd.format(cents / 100);
}

function closingValue(days: number | null): string {
  if (days === null) return "Not set";
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"}`;
  if (days === 0) return "Today";
  return "Closed";
}

type Props = { publicId: string };

export async function LlcOverview({ publicId }: Props) {
  const { allow } = await serverAccessControl();
  const canRead = allow(true, ["stakeholder", "read"], false);
  const overview = canRead ? await api.memberSchedule.overview() : null;

  const activities = (
    <ActivitiesCard
      publicId={publicId}
      className="border-none bg-transparent shadow-none"
    />
  );

  const header = (
    <header>
      <h3 className="font-medium">Overview</h3>
      <p className="text-sm text-muted-foreground">
        Commitments, capital and members of your company
      </p>
    </header>
  );

  if (!overview) {
    return (
      <>
        {header}
        <div className="mt-6 max-w-xl">{activities}</div>
      </>
    );
  }

  const { indicators: ind } = overview;
  const commitmentsHref = `/${publicId}/commitments`;
  const noCommitments = ind.committedCents === 0 && ind.pendingCount === 0;

  const attention: string[] = [];
  if (ind.overdueDecisions > 0) {
    attention.push(
      ind.overdueDecisions === 1
        ? "1 subscription is past its decision deadline"
        : `${ind.overdueDecisions} subscriptions are past their decision deadline`,
    );
  }
  if (ind.refundsOutstandingCents > 0) {
    attention.push(
      `Refunds of ${formatCents(ind.refundsOutstandingCents)} are outstanding`,
    );
  }
  if (ind.finalClosingDate === null) {
    attention.push("Final Closing Date is not set");
  }

  return (
    <>
      {header}

      {attention.length > 0 ? (
        <section className="mt-6 flex flex-col gap-y-2">
          {attention.map((text) => (
            <Alert key={text} variant="destructive">
              <AlertDescription>
                <Link href={commitmentsHref} className="underline">
                  {text}
                </Link>
              </AlertDescription>
            </Alert>
          ))}
        </section>
      ) : null}

      <div className="grid gap-8 md:grid-cols-12">
        <div className="sm:col-span-12 md:col-span-6 lg:col-span-8">
          <section className="mt-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <StatCard
                title="Committed"
                value={
                  ind.capCents === null
                    ? formatCentsCompact(ind.committedCents)
                    : `${formatCentsCompact(ind.committedCents)} of ${formatCentsCompact(ind.capCents)}`
                }
                progressBps={ind.capUsedBps}
              >
                {ind.remainingCents === null ? (
                  <span>No offering cap set</span>
                ) : (
                  <span>Remaining {formatCents(ind.remainingCents)}</span>
                )}
                <span>
                  {ind.pendingCount} pending (
                  {formatCents(ind.pendingCommittedCents)})
                </span>
                {noCommitments ? (
                  <Link href={`/${publicId}/admissions`} className="underline">
                    No commitments yet
                  </Link>
                ) : null}
              </StatCard>

              <StatCard
                title="Paid to date"
                value={formatCents(overview.paidCents)}
              />

              <StatCard
                title="Outstanding Balance"
                value={formatCents(overview.outstandingBalanceCents)}
              />

              <StatCard title="Members" value={overview.memberCount}>
                <span>
                  {overview.prospectCount}{" "}
                  {overview.prospectCount === 1 ? "prospect" : "prospects"}
                </span>
              </StatCard>

              <StatCard
                title="Final Closing"
                value={closingValue(ind.daysToFinalClosing)}
              >
                {ind.finalClosingDate === null ? (
                  <Link
                    href={`/${publicId}/unit-classes`}
                    className="underline"
                  >
                    Set it on Unit classes
                  </Link>
                ) : (
                  <span>{formatDateOnly(ind.finalClosingDate)}</span>
                )}
              </StatCard>
            </div>
          </section>
        </div>

        <div className="mt-6 sm:col-span-12 md:col-span-6 lg:col-span-4">
          {activities}
        </div>
      </div>

      <section className="mt-10">
        <EconomicsSlot />
      </section>
    </>
  );
}
