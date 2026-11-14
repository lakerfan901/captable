import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { IsoDateText, Money, Units } from "@/components/llc/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { addDays } from "@/lib/llc/dates";
import {
  STATEMENT_BEGINNING,
  statementAsOf,
  statementQuarters,
} from "@/lib/llc/statement-as-of";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { getSessionEntity } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { api } from "@/trpc/server";
import type { RouterOutputs } from "@/trpc/shared";

type Statement = RouterOutputs["llcEconomics"]["memberStatement"];

const KIND_LABEL: Record<Statement["activity"][number]["kind"], string> = {
  CONTRIBUTION: "Contribution",
  CREDIT: "Credit",
  REPLACEMENT: "Replacement",
  FORFEITURE: "Forfeiture",
  DISTRIBUTION: "Distribution",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  TAX_ADVANCE: "Tax advance",
};

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="text-lg font-semibold">{children}</CardContent>
    </Card>
  );
}

function BalanceRow({ label, s }: { label: string; s: Statement["opening"] }) {
  return (
    <TableRow className="font-medium">
      <TableCell colSpan={2}>{label}</TableCell>
      <TableCell className="text-right">
        <Money cents={s.unreturned} />
      </TableCell>
      <TableCell className="text-right">
        <Units micro={s.preferredUnits} />
      </TableCell>
      <TableCell className="text-right">
        <Money cents={s.unpaidReturn} />
      </TableCell>
    </TableRow>
  );
}

function StatementTable({ s }: { s: Statement }) {
  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Activity</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead className="text-right">
              Unpaid Preferred Return
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <BalanceRow
            label={`Opening balance (unreturned capital, Preferred Units, unpaid return) as of ${addDays(s.from, -1)}`}
            s={s.opening}
          />
          {s.activity.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No activity in this period.
              </TableCell>
            </TableRow>
          ) : (
            s.activity.map((a) => (
              <TableRow key={`${a.kind}:${a.refId}`}>
                <TableCell>
                  <IsoDateText date={a.on} />
                </TableCell>
                <TableCell>
                  {KIND_LABEL[a.kind]}
                  <span className="block text-xs text-muted-foreground">
                    {a.description}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={a.amount} />
                </TableCell>
                <TableCell className="text-right">
                  <Units micro={a.units} />
                </TableCell>
                <TableCell />
              </TableRow>
            ))
          )}
          <BalanceRow label={`Closing balance as of ${s.to}`} s={s.closing} />
        </TableBody>
      </Table>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm md:grid-cols-4">
        {(
          [
            ["Contributions", s.period.contributions],
            ["Credits", s.period.credits],
            ["Forfeited", s.period.forfeited],
            ["Return accrued", s.period.returnAccrued],
            ["Return paid (tier c)", s.period.returnPaid],
            ["Return extinguished", s.period.returnExtinguished],
            ["Capital returned (tier d)", s.period.capitalReturned],
            ["Residual paid (tier e)", s.period.residualPaid],
            ["Gross distributions", s.period.grossDistributions],
            ["Default offsets", s.period.defaultOffsets],
            ["Tax advance offsets", s.period.taxAdvanceOffsets],
            ["Net paid", s.period.netPaid],
          ] as const
        ).map(([label, cents]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>
              <Money cents={cents} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** GET form: reloads the member page on the Economics tab as of the date. */
function AsOfForm({ asOf, today }: { asOf: string; today: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
      <input type="hidden" name="tab" value="economics" />
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Figures as of</span>
        <input
          type="date"
          name="asOf"
          defaultValue={asOf}
          min={STATEMENT_BEGINNING}
          max={today}
          className="h-9 rounded-md border bg-background px-2"
        />
      </label>
      <Button type="submit" variant="outline" size="sm">
        Show
      </Button>
      {asOf !== today && (
        <Button asChild variant="ghost" size="sm">
          <Link href="?tab=economics">Today</Link>
        </Button>
      )}
    </form>
  );
}

/**
 * Member economics (E18) for FOUNDATION's member detail page: headline cards,
 * default banner, quarterly statements, link to the fair-value page.
 * Every figure is as of `asOf` (default today): the cards are the statement
 * from the beginning to `asOf` (E18: closing balances "as of to"), and the
 * quarter tabs are the four quarters up to the one containing `asOf`, the
 * last one cut at `asOf`. Returns null when the caller lacks
 * `distributions: read`.
 */
export async function EconomicsTab({
  stakeholderId,
  asOf: requestedAsOf,
}: {
  stakeholderId: string;
  /** `?asOf=` of the page, validated here; today when absent or invalid. */
  asOf?: string;
}) {
  const { allow } = await serverAccessControl();
  const canRead = allow(true, ["distributions", "read"], false);
  if (!canRead) return null;

  const entity = await getSessionEntity();
  const today = economicsToday(entity.timezone);
  const asOf = statementAsOf(requestedAsOf, today);

  const quarters = statementQuarters(asOf);

  let toDate: Statement;
  let byQuarter: Statement[];
  try {
    toDate = await api.llcEconomics.memberStatement({
      stakeholderId,
      from: STATEMENT_BEGINNING,
      to: asOf,
    });
    byQuarter = await Promise.all(
      quarters.map((q) =>
        api.llcEconomics.memberStatement({
          stakeholderId,
          from: q.from,
          to: q.to,
        }),
      ),
    );
  } catch (error) {
    if (error instanceof TRPCError) {
      return (
        <Alert>
          <AlertDescription>
            Economics are not available: {error.message}
          </AlertDescription>
        </Alert>
      );
    }
    throw error;
  }

  const c = toDate.closing;
  const openDefaults = toDate.defaults.filter((d) => d.status === "OPEN");

  return (
    <div className="flex flex-col gap-3">
      <AsOfForm asOf={asOf} today={today} />
      {openDefaults.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>
            {asOf === today ? "In default" : `In default on ${asOf}`}
          </AlertTitle>
          <AlertDescription>
            {openDefaults.map((d) => (
              <span key={d.memberDefaultId} className="block">
                Balance <Money cents={d.outstandingBalance} />, interest{" "}
                <Money cents={d.interestOwed} />, costs{" "}
                <Money cents={d.costsOwed} /> owed.
              </span>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat label="Capital Contributions paid">
          <Money cents={c.contributed} />
        </Stat>
        <Stat label="Unreturned Capital">
          <Money cents={c.unreturned} />
        </Stat>
        <Stat label="Preferred Units">
          <Units micro={c.preferredUnits} />{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({c.preferredPct}%)
          </span>
        </Stat>
        <Stat label={`Preferred Return accrued as of ${asOf}`}>
          <Money cents={c.accruedReturn} />
        </Stat>
        <Stat label={`Preferred Return unpaid as of ${asOf}`}>
          <Money cents={c.unpaidReturn} />
        </Stat>
        <Stat
          label={
            asOf === today
              ? "Distributions received to date"
              : `Distributions received through ${asOf}`
          }
        >
          <Money cents={toDate.period.grossDistributions} />
          <span className="block text-xs font-normal text-muted-foreground">
            Tier (c) <Money cents={toDate.period.returnPaid} /> · tier (d){" "}
            <Money cents={toDate.period.capitalReturned} /> · tier (e){" "}
            <Money cents={toDate.period.residualPaid} />
          </span>
        </Stat>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Statement</CardTitle>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/${entity.publicId}/fair-value?stakeholderId=${encodeURIComponent(stakeholderId)}`}
            >
              Fair value
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue={quarters[0]?.key}>
            <TabsList>
              {quarters.map((q) => (
                <TabsTrigger key={q.key} value={q.key}>
                  {q.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {quarters.map((q, i) => {
              const s = byQuarter[i];
              return (
                <TabsContent key={q.key} value={q.key}>
                  {s ? <StatementTable s={s} /> : null}
                </TabsContent>
              );
            })}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
