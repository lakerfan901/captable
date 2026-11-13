import type { Metadata } from "next";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { isValidDateOnly } from "@/lib/date-only";
import { quarterOf } from "@/lib/llc/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { api } from "@/trpc/server";
import { AdvanceDialog } from "../components/advance-dialog";
import { AdvanceTable } from "../components/advance-table";
import { LoanDialog } from "../components/loan-dialog";
import { LoanTable } from "../components/loan-table";
import { DateRangeFilter } from "../components/shared";

export const metadata: Metadata = { title: "Loans & advances" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoansAdvancesPage({
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

  const loans = await allow(api.llcFinancials.loan.list(), [
    "llc-financials",
    "read",
  ]);
  if (!loans) return <UnAuthorizedState />;
  const advances = await api.llcFinancials.advance.list();

  const canCreate = allow(true, ["llc-financials", "create"], false);
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
    <div className="flex flex-col gap-y-8">
      <section className="flex flex-col gap-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="font-medium">Member loans</h3>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Loans from members are repaid under their promissory notes before
              distributions (Section 4.6). An operating or sale distribution
              cannot be finalized while a matured loan has principal
              outstanding. Interest shown is simple, actual/365, for
              information; enter the amounts actually paid.
            </p>
          </div>
          {canCreate ? (
            <LoanDialog
              today={today}
              stakeholders={stakeholders}
              documents={documents}
            />
          ) : null}
        </div>
        <LoanTable data={loans} canCreate={canCreate} today={today} />
      </section>

      <section className="flex flex-col gap-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="font-medium">Tax advances</h3>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Tax paid on a member&apos;s behalf is an advance recovered from
              that member&apos;s next distributions, or repaid on demand
              (Section 9.2).
            </p>
          </div>
          {canCreate ? (
            <div className="flex flex-wrap gap-2">
              <AdvanceDialog
                mode="advance"
                today={today}
                stakeholders={stakeholders}
                documents={documents}
              />
              <AdvanceDialog
                mode="repayment"
                today={today}
                stakeholders={stakeholders}
                documents={documents}
              />
            </div>
          ) : null}
        </div>
        <DateRangeFilter from={from} to={to} />
        <AdvanceTable data={advances} from={from} to={to} />
      </section>
    </div>
  );
}
