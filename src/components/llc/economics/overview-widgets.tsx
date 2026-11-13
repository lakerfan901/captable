import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { IsoDateText, Money } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
import { daysBetween } from "@/lib/llc/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { getSessionEntity } from "@/server/entity";
import { api } from "@/trpc/server";
import type { RouterOutputs } from "@/trpc/shared";
import { WidgetCard, WidgetLine, WidgetValue } from "./widget-card";

type Overview = RouterOutputs["llcEconomics"]["overview"];

function daysText(today: string, on: string): string {
  const days = daysBetween(today, on);
  if (days === 0) return "Due today";
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"} left`;
  return `${-days} ${days === -1 ? "day" : "days"} overdue`;
}

function CapBar({ counted, limit }: { counted: number; limit: number }) {
  // display only
  const pct =
    limit <= 0 ? 100 : Math.min(100, Math.max(0, (counted / limit) * 100));
  return (
    <div className="h-2 w-full rounded-full bg-muted">
      <div
        className={
          counted > limit
            ? "h-2 rounded-full bg-red-500"
            : "h-2 rounded-full bg-primary"
        }
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Widgets({ o, base }: { o: Overview; base: string }) {
  const nd = o.nextDistribution;
  const noDistributions =
    o.returns.distributedToDate.tierC === 0 &&
    o.returns.distributedToDate.tierD === 0 &&
    o.returns.distributedToDate.tierE === 0;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <WidgetCard
        title="Capital"
        href={`${base}/capital-calls`}
        linkLabel="Capital calls"
      >
        <WidgetValue>
          <Money cents={o.capital.paid} />
        </WidgetValue>
        <WidgetLine label="Committed">
          <Money cents={o.capital.committed} />
        </WidgetLine>
        <WidgetLine label="Uncalled Balance">
          <Money cents={o.capital.uncalled} />
        </WidgetLine>
      </WidgetCard>

      <WidgetCard
        title="Preferred position"
        href={`${base}/distributions`}
        linkLabel="Distributions"
      >
        <WidgetValue>
          <Money cents={o.returns.unreturnedCapital} />
        </WidgetValue>
        <WidgetLine label="Unreturned Capital">
          <Money cents={o.returns.unreturnedCapital} />
        </WidgetLine>
        <WidgetLine label="Unpaid Preferred Return">
          <Money cents={o.returns.unpaidPreferredReturn} />
        </WidgetLine>
        {noDistributions ? (
          <p className="text-xs text-muted-foreground">No distributions yet</p>
        ) : (
          <WidgetLine label="Distributed">
            <Money
              cents={
                o.returns.distributedToDate.tierC +
                o.returns.distributedToDate.tierD +
                o.returns.distributedToDate.tierE
              }
            />
          </WidgetLine>
        )}
      </WidgetCard>

      <WidgetCard
        title="Available Cash"
        href={`${base}/financials`}
        linkLabel="Financials"
      >
        <WidgetValue>
          <Money cents={o.cash.availableCash} />
        </WidgetValue>
        <p className="text-xs text-muted-foreground">
          Estimate as of <IsoDateText date={o.cash.asOf} />
        </p>
        <WidgetLine label="Reserves">
          <Money cents={o.cash.reserveBalance} />
        </WidgetLine>
        {o.cash.minimumMet ? null : (
          <Badge variant="destructive" className="w-fit">
            Below the <Money cents={o.cash.minimumReserve} /> minimum
          </Badge>
        )}
      </WidgetCard>

      <WidgetCard
        title="Next distribution deadline"
        danger={!nd.distributed && daysBetween(o.today, nd.deadline) < 0}
      >
        <WidgetValue>
          <IsoDateText date={nd.deadline} />
        </WidgetValue>
        <WidgetLine label="Quarter">{nd.label}</WidgetLine>
        <p className="text-xs text-muted-foreground">
          {nd.distributed
            ? "Distribution recorded"
            : daysText(o.today, nd.deadline)}
        </p>
      </WidgetCard>

      <WidgetCard title="Management Fee">
        <WidgetValue>
          <Money cents={o.fee.accruedToDate} />
        </WidgetValue>
        <WidgetLine label="Accrued to date">
          <Money cents={o.fee.accruedToDate} />
        </WidgetLine>
        <WidgetLine label="Unpaid">
          <Money cents={o.fee.unpaid} />
        </WidgetLine>
      </WidgetCard>

      <WidgetCard
        title="§6.21 organizational expense cap"
        danger={o.orgCap.counted > o.orgCap.limit}
      >
        <WidgetValue>
          <Money cents={o.orgCap.counted} />
        </WidgetValue>
        <CapBar counted={o.orgCap.counted} limit={o.orgCap.limit} />
        <WidgetLine label="Limit">
          <Money cents={o.orgCap.limit} />
        </WidgetLine>
      </WidgetCard>

      <WidgetCard
        title="Capital calls"
        href={`${base}/capital-calls`}
        linkLabel="Capital calls"
        danger={o.calls.overdueLines > 0}
      >
        <WidgetValue
          className={o.calls.overdueLines > 0 ? "text-red-700" : undefined}
        >
          {o.calls.openLines} open
        </WidgetValue>
        <WidgetLine label="Overdue">{o.calls.overdueLines}</WidgetLine>
        <WidgetLine label="Defaults">{o.calls.openDefaults}</WidgetLine>
        {o.calls.nextDueOn ? (
          <WidgetLine label="Next due">
            <IsoDateText date={o.calls.nextDueOn} />
          </WidgetLine>
        ) : null}
      </WidgetCard>

      <WidgetCard title="Term">
        {o.term.ocd === null ? (
          <Link
            href={`${base}/settings/llc-term`}
            className="text-sm underline underline-offset-2"
          >
            Set the Operations Commencement Date
          </Link>
        ) : (
          <>
            <WidgetValue>
              <IsoDateText date={o.term.effectiveTargetSaleDate} />
            </WidgetValue>
            <WidgetLine label="Target Sale Date">
              <IsoDateText date={o.term.effectiveTargetSaleDate} />
            </WidgetLine>
            <WidgetLine label="Extension request due">
              <IsoDateText date={o.term.extensionRequestDueOn} />
            </WidgetLine>
          </>
        )}
      </WidgetCard>

      {o.nextDeadlines.length > 0 ? (
        <div className="col-span-2 lg:col-span-4">
          <WidgetCard title="Upcoming dates">
            <ul className="flex flex-col gap-1">
              {o.nextDeadlines.map((d) => (
                <li
                  key={d.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span>
                    {d.label}{" "}
                    <span className="text-xs text-muted-foreground">
                      {d.oaSection}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <IsoDateText date={d.dueOn} />
                    {d.status === "OVERDUE" ||
                    d.status === "ACTION_REQUIRED" ? (
                      <Badge variant="destructive">
                        {d.status === "OVERDUE" ? "Overdue" : "Action required"}
                      </Badge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </WidgetCard>
        </div>
      ) : null}
    </div>
  );
}

/** Economics cards on the LLC Overview (E19). Null without `distributions: read`. */
export async function LlcEconomicsWidgets() {
  const { allow } = await serverAccessControl();
  if (!allow(true, ["distributions", "read"], false)) return null;
  const { publicId } = await getSessionEntity();
  let overview: Overview;
  try {
    overview = await api.llcEconomics.overview();
  } catch (e) {
    // e.g. the Preferred unit class terms are not complete yet
    if (e instanceof TRPCError && e.code === "BAD_REQUEST") {
      return (
        <p className="text-sm text-muted-foreground">
          Economics appear here once the Preferred unit class terms are set.{" "}
          <Link href={`/${publicId}/unit-classes`} className="underline">
            Unit classes
          </Link>
        </p>
      );
    }
    throw e;
  }
  return <Widgets o={overview} base={`/${publicId}`} />;
}
