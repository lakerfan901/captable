import type { Metadata } from "next";
import { Money } from "@/components/llc/money";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { isValidDateOnly } from "@/lib/date-only";
import { quarterOf } from "@/lib/llc/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { api } from "@/trpc/server";
import { ReserveDialog } from "../components/reserve-dialog";
import { ReserveBalanceTable, ReserveTable } from "../components/reserve-table";
import { DateRangeFilter } from "../components/shared";

export const metadata: Metadata = { title: "Reserves" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ReservesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const today = economicsToday(entity.timezone);
  const sp = await searchParams;
  const quarter = quarterOf(today);
  const from =
    typeof sp.from === "string" && isValidDateOnly(sp.from)
      ? sp.from
      : quarter.start;
  const to =
    typeof sp.to === "string" && isValidDateOnly(sp.to) ? sp.to : quarter.end;

  const list = await allow(api.llcFinancials.reserve.list({ asOf: to }), [
    "llc-financials",
    "read",
  ]);
  if (!list) return <UnAuthorizedState />;
  const balances = await api.llcFinancials.reserve.balances({});
  const rows = list.rows.filter((r) => r.effectiveOn >= from);
  const canCreate = allow(true, ["llc-financials", "create"], false);
  const canReverse = allow(true, ["llc-financials", "delete"], false);

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-medium">Reserves</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The Manager maintains a minimum operating reserve and may establish
            additional reserves (Section 5.6(a)). Each reserve balance sits in
            the pool it was funded from: operating cash (excluded from Available
            Cash) or capital contributions (excluded from unused capital).
          </p>
        </div>
        {canCreate ? (
          <div className="flex gap-2">
            <ReserveDialog mode="establish" today={today} />
            <ReserveDialog mode="release" today={today} />
          </div>
        ) : null}
      </div>

      <Alert>
        <AlertDescription>
          Release rule: a released amount returns to the pool it was funded from
          — a release of an operating-cash reserve increases Available Cash; a
          release of a capital-funded reserve increases unused capital. The
          Manager may release into the other pool with a reason; that release
          cannot be reversed.
        </AlertDescription>
      </Alert>

      <div className="text-sm">
        Minimum operating reserve today:{" "}
        <Money cents={balances.byKind.MINIMUM_OPERATING?.total ?? 0} /> of{" "}
        <Money cents={balances.minimumRequired} /> required.{" "}
        {balances.minimumMet ? (
          <span className="text-green-700">Met.</span>
        ) : (
          <span className="text-destructive">
            Below the minimum: an operating distribution cannot be finalized.
          </span>
        )}
      </div>
      <ReserveBalanceTable balances={balances} />

      <DateRangeFilter from={from} to={to} />
      <ReserveTable rows={rows} canReverse={canReverse} />
    </div>
  );
}
