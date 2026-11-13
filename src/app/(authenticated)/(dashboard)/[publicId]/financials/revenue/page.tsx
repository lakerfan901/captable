import type { Metadata } from "next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { api } from "@/trpc/server";
import { RevenueGrid, RevenueYearSelect } from "../components/revenue-grid";

export const metadata: Metadata = { title: "Revenue" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const today = economicsToday(entity.timezone);
  const currentYear = Number(today.slice(0, 4));
  const raw = (await searchParams).year;
  const requested = typeof raw === "string" ? Number(raw) : Number.NaN;
  const year =
    Number.isInteger(requested) && requested >= 2020 && requested <= 2100
      ? requested
      : currentYear;

  const data = await allow(api.llcFinancials.revenue.list({ year }), [
    "llc-financials",
    "read",
  ]);
  if (!data) return <UnAuthorizedState />;
  const canEdit = allow(true, ["llc-financials", "create"], false);
  const years: number[] = [];
  for (
    let y = Math.max(2020, Math.min(year, currentYear) - 5);
    y <= Math.max(year, currentYear);
    y++
  ) {
    years.push(y);
  }

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-medium">Revenue</h3>
          <p className="text-sm text-muted-foreground">
            Monthly cash receipts. The Management Fee (Section 6.18) accrues
            monthly on Gross Revenue.
          </p>
        </div>
        <RevenueYearSelect year={year} years={years} />
      </div>
      <Alert>
        <AlertDescription>
          Enter cash actually received from customers in the month. Enter
          marketplace commissions, platform fees and payment-processing fees in
          &apos;Pass-through fees&apos; — do not also enter them as expenses. If
          a marketplace pays you net of its fees, enter the net amount as
          receipts and 0 as fees. Interest, asset-sale and insurance proceeds
          are not part of Gross Revenue and carry no Management Fee.
        </AlertDescription>
      </Alert>
      <RevenueGrid
        data={data}
        currentMonth={`${today.slice(0, 7)}-01`}
        canEdit={canEdit}
      />
    </div>
  );
}
