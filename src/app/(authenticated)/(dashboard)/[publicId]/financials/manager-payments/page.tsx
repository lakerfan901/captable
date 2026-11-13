import type { Metadata } from "next";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { isValidDateOnly } from "@/lib/date-only";
import { quarterOf } from "@/lib/llc/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { api } from "@/trpc/server";
import { ManagerPaymentDialog } from "../components/manager-payment-dialog";
import { ManagerPaymentTable } from "../components/manager-payment-table";
import { OrgCapCard } from "../components/org-cap-card";
import { DateRangeFilter } from "../components/shared";

export const metadata: Metadata = { title: "Manager payments" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ManagerPaymentsPage({
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

  const data = await allow(
    api.llcFinancials.managerPayment.list({ from, to }),
    ["llc-financials", "read"],
  );
  if (!data) return <UnAuthorizedState />;
  const capStatus = await api.llcFinancials.managerPayment.capStatus();

  const canCreate = allow(true, ["llc-financials", "create"], false);
  const canReverse = allow(true, ["llc-financials", "delete"], false);
  const documents = allow(true, ["documents", "read"], false)
    ? (await api.document.getAll()).map((d) => ({ id: d.id, name: d.name }))
    : [];
  const stakeholders = allow(true, ["stakeholder", "read"], false)
    ? (await api.stakeholder.getStakeholders()).map((s) => ({
        id: s.id,
        name: s.name,
      }))
    : [];

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-medium">Manager payments</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every amount paid by the LLC to or through the Manager and its
            Affiliates, listed in each quarterly report (Section 8.2).
          </p>
        </div>
        {canCreate ? (
          <ManagerPaymentDialog
            today={today}
            documents={documents}
            stakeholders={stakeholders}
          />
        ) : null}
      </div>
      <OrgCapCard status={capStatus} showEntries />
      <DateRangeFilter from={from} to={to} />
      <ManagerPaymentTable data={data} canReverse={canReverse} />
    </div>
  );
}
