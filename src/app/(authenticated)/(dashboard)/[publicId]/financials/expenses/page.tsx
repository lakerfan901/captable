import type { Metadata } from "next";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { isValidDateOnly } from "@/lib/date-only";
import { quarterOf } from "@/lib/llc/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { api } from "@/trpc/server";
import { ExpenseDialog } from "../components/expense-dialog";
import { ExpenseTable } from "../components/expense-table";
import { DateRangeFilter } from "../components/shared";

export const metadata: Metadata = { title: "Expenses" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ExpensesPage({
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

  const data = await allow(api.llcFinancials.expense.list({ from, to }), [
    "llc-financials",
    "read",
  ]);
  if (!data) return <UnAuthorizedState />;

  const canCreate = allow(true, ["llc-financials", "create"], false);
  const canReverse = allow(true, ["llc-financials", "delete"], false);
  const documents = allow(true, ["documents", "read"], false)
    ? (await api.document.getAll()).map((d) => ({ id: d.id, name: d.name }))
    : [];

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-medium">Expenses</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Expenses paid from operating cash reduce Available Cash; expenses
            paid from capital contributions reduce unused capital (Section
            1.15). Marketplace commissions, platform fees and payment-processing
            fees are deducted from Gross Revenue on the Revenue page; do not
            also enter them as expenses.
          </p>
        </div>
        {canCreate ? (
          <ExpenseDialog today={today} documents={documents} />
        ) : null}
      </div>
      <DateRangeFilter from={from} to={to} />
      <ExpenseTable data={data} canReverse={canReverse} />
    </div>
  );
}
