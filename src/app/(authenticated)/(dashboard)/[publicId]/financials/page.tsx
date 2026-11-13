import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { IsoDateText, Money } from "@/components/llc/money";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { AvailableCashCard } from "./components/available-cash-card";
import { OrgCapCard } from "./components/org-cap-card";

export const metadata: Metadata = { title: "Financials" };

function Row({
  label,
  cents,
  strong,
}: {
  label: string;
  cents: number;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 py-1 ${strong ? "border-t pt-2 font-semibold" : ""}`}
    >
      <span>{label}</span>
      <Money cents={cents} />
    </div>
  );
}

async function loadSummary() {
  try {
    return await api.llcFinancials.summary({});
  } catch (e) {
    // The layout shows the rule violation (e.g. no price per unit).
    if (e instanceof TRPCError && e.code === "BAD_REQUEST") return null;
    throw e;
  }
}

export default async function FinancialsSummaryPage() {
  await requireLlc();
  const { allow } = await serverAccessControl();
  if (!allow(true, ["llc-financials", "read"], false)) {
    return <UnAuthorizedState />;
  }
  const s = await loadSummary();
  if (!s) {
    return (
      <p className="text-sm text-muted-foreground">
        The summary is unavailable until the problem shown above is fixed.
      </p>
    );
  }
  const minimum = await api.llcFinancials.reserve.balances({});
  const u = s.unusedCapital;
  const loansOutstanding = s.loans.reduce(
    (acc, l) => acc + l.principalOutstanding,
    0,
  );
  const loanInterest = s.loans.reduce(
    (acc, l) => acc + l.accruedInterest - l.interestPaid,
    0,
  );
  const minimumHeld = s.reserves.byKind.MINIMUM_OPERATING?.total ?? 0;

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-medium">Summary</h3>
          <p className="text-sm text-muted-foreground">
            As of <IsoDateText date={s.asOf} />. Books closed through{" "}
            <IsoDateText date={s.booksClosedThrough} />.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AvailableCashCard availableCash={s.availableCash} />

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Unused capital</CardTitle>
              <CardDescription>
                Capital-side cash, tracked apart from Available Cash (Section
                1.15).
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <Row
                label="+ Capital contributions received"
                cents={u.capitalReceived}
              />
              <Row label="+ Member-loan proceeds" cents={u.loanProceeds} />
              <Row label="− Spent from capital" cents={u.spentFromCapital} />
              <Row
                label="− Reserves held from capital"
                cents={u.reservesFromCapital}
              />
              <Row
                label="− Returned to members (Section 5.6(d))"
                cents={u.returned}
              />
              <Row
                label="− Member-loan service paid from capital"
                cents={u.loanServiceFromCapital}
              />
              <Row strong label="Unused capital" cents={u.unusedCapital} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reserves</CardTitle>
              <CardDescription>Section 5.6(a)</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <Row label="From operating cash" cents={s.reserves.operating} />
              <Row
                label="From capital contributions"
                cents={s.reserves.capital}
              />
              <Row
                strong
                label="Total reserve balance"
                cents={s.reserves.total}
              />
              <div className="mt-2">
                Minimum operating reserve: <Money cents={minimumHeld} /> of{" "}
                <Money cents={minimum.minimumRequired} />{" "}
                {minimum.minimumMet ? (
                  <span className="text-green-700">— met</span>
                ) : (
                  <span className="text-destructive">— below the minimum</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Management Fee</CardTitle>
            <CardDescription>
              5% of Gross Revenue, accrued monthly, paid quarterly (Section
              6.18).
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="grid grid-cols-3 gap-2 border-b pb-1 text-xs font-medium text-muted-foreground">
              <span />
              <span className="text-right">
                This quarter (<IsoDateText date={s.fee.quarter.from} /> –{" "}
                <IsoDateText date={s.fee.quarter.to} />)
              </span>
              <span className="text-right">To date</span>
            </div>
            <div className="grid grid-cols-3 gap-2 py-1">
              <span>Accrued</span>
              <Money
                className="text-right"
                cents={s.fee.quarter.accruedInRange}
              />
              <Money
                className="text-right"
                cents={s.fee.toDate.accruedToDate}
              />
            </div>
            <div className="grid grid-cols-3 gap-2 py-1">
              <span>Paid</span>
              <Money className="text-right" cents={s.fee.quarter.paidInRange} />
              <Money className="text-right" cents={s.fee.toDate.paidToDate} />
            </div>
            <div className="grid grid-cols-3 gap-2 border-t py-1 font-semibold">
              <span>Unpaid</span>
              <span />
              <Money className="text-right" cents={s.fee.toDate.unpaid} />
            </div>
          </CardContent>
        </Card>

        <OrgCapCard status={s.orgCap} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Loans and tax advances</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Row
              label="Member-loan principal outstanding"
              cents={loansOutstanding}
            />
            <Row
              label="Member-loan interest accrued and unpaid"
              cents={loanInterest}
            />
            {s.loans.some(
              (l) => l.pastMaturity && l.principalOutstanding > 0,
            ) ? (
              <p className="text-destructive">
                A loan is past maturity with principal outstanding: operating
                and sale distributions are blocked (Section 4.6).
              </p>
            ) : null}
            <Row
              label="Tax advances outstanding"
              cents={s.advancesOutstanding}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
