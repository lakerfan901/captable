import type { Metadata } from "next";
import Link from "next/link";
import { IsoDateText, Money, Units } from "@/components/llc/money";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { ChargeDialog } from "../components/charge-dialog";
import { CreditDialog } from "../components/credit-dialog";
import { CureDialog } from "../components/cure-dialog";
import { DefaultPaymentDialog } from "../components/default-payment-dialog";
import { StageBadge } from "../components/default-table";
import { DefaultTimeline } from "../components/default-timeline";
import { ForfeitureDialog } from "../components/forfeiture-dialog";
import { FundingDialog } from "../components/funding-dialog";

export const metadata: Metadata = { title: "Default" };

export default async function DefaultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const entity = await requireLlc();
  const { id } = await params;
  const { allow } = await serverAccessControl();
  const data = await allow(api.memberDefault.get({ id }), [
    "capital-calls",
    "read",
  ]);
  if (!data) return <UnAuthorizedState />;
  const canCreate = allow(true, ["capital-calls", "create"], false);
  const canUpdate = allow(true, ["capital-calls", "update"], false);
  const stakeholders = allow(true, ["stakeholder", "read"], false)
    ? await api.stakeholder.getStakeholders()
    : [];
  const names: Record<string, string> = Object.fromEntries(
    stakeholders.map((s) => [s.id, s.name]),
  );
  const { view, today } = data;
  const base = `/${entity.publicId}/capital-calls`;
  const action = (
    a: "CONFIRM_FORFEITURE" | "CONFIRM_CREDIT" | "CONFIRM_CURE",
  ) => view.actions.find((x) => x.action === a);
  const ff = action("CONFIRM_FORFEITURE");
  const cr = action("CONFIRM_CREDIT");
  const cu = action("CONFIRM_CURE");
  const isOpen = view.status === "OPEN";
  const notVoided = view.status !== "VOIDED";

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <Link
          href={`${base}/defaults`}
          className="text-sm text-muted-foreground"
        >
          ← Defaults
        </Link>
        <h3 className="flex items-center gap-2 font-medium">
          Default: {view.memberName}
          <StageBadge stage={view.stage} />
        </h3>
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href={`${base}/${view.callNoticeId}`}>
            Call Notice No. {view.callNoticeNumber}
          </Link>
          , due <IsoDateText date={view.dueOn} />. Figures as of{" "}
          <IsoDateText date={today} />.
        </p>
        {view.status === "VOIDED" ? (
          <p className="text-sm text-muted-foreground">
            Voided: {view.voidReason}
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <Stat
          label="Unpaid at due date"
          value={<Money cents={view.declaredUnpaidAtDue} />}
        />
        <Stat
          label="Outstanding Balance"
          value={<Money cents={view.outstandingBalance} />}
        />
        <Stat
          label="Interest owed"
          value={<Money cents={view.interestOwed} />}
        />
        <Stat label="Costs owed" value={<Money cents={view.costsOwed} />} />
        <Stat label="Suspended" value={view.suspendedToday ? "Yes" : "No"} />
      </div>

      {view.unpaidAtDue !== view.declaredUnpaidAtDue ? (
        <Alert variant="destructive">
          <AlertDescription>
            The unpaid amount at the due date recomputed from the line (
            <Money cents={view.unpaidAtDue} />) differs from the amount stored
            at declaration (<Money cents={view.declaredUnpaidAtDue} />
            ): a receipt dated on or before the due date was voided since.
          </AlertDescription>
        </Alert>
      ) : null}
      {view.cure.blockedByForfeiture ? (
        <Alert>
          <AlertDescription>
            The cure condition is met, but the forfeiture became due first:
            confirm the forfeiture before the cure.
          </AlertDescription>
        </Alert>
      ) : null}

      {notVoided ? (
        <div className="flex flex-wrap gap-2">
          {canUpdate && ff ? (
            <ForfeitureDialog view={view} available={ff.available} />
          ) : null}
          {canUpdate && cr ? (
            <CreditDialog
              view={view}
              available={cr.available}
              availableOn={cr.availableOn}
              names={names}
            />
          ) : null}
          {canUpdate && cu?.available ? <CureDialog view={view} /> : null}
          {canCreate && isOpen ? (
            <FundingDialog
              view={view}
              today={today}
              stakeholders={stakeholders.map((s) => ({
                id: s.id,
                name: s.name,
              }))}
            />
          ) : null}
          {canCreate ? (
            <DefaultPaymentDialog view={view} today={today} />
          ) : null}
          {canCreate ? <ChargeDialog view={view} today={today} /> : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <DefaultTimeline view={view} today={today} />
          </CardContent>
        </Card>
        <div className="grid gap-4">
          {view.forfeiture.recorded ? (
            <Card>
              <CardHeader>
                <CardTitle>Forfeiture</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                <div>
                  Effective{" "}
                  <IsoDateText date={view.forfeiture.recorded.forfeitedOn} />:
                  Forfeited Amount{" "}
                  <Money cents={view.forfeiture.recorded.forfeited} /> (unpaid{" "}
                  <Money cents={view.forfeiture.recorded.unpaidAtForfeiture} />,
                  cap <Money cents={view.forfeiture.recorded.capitalPaid} />)
                </div>
                <div>
                  Preferred Units{" "}
                  <Units micro={view.forfeiture.recorded.unitsBefore} /> →{" "}
                  <Units micro={view.forfeiture.recorded.unitsAfter} />
                  {"; "}
                  Preferred Return extinguished{" "}
                  <Money cents={view.forfeiture.recorded.extinguishedReturn} />
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Replacement Funder fundings</CardTitle>
            </CardHeader>
            <CardContent>
              {view.fundings.length === 0 ? (
                <Empty />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Funder</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.fundings.map((f) => (
                      <TableRow key={f.id}>
                        <TableCell>
                          {f.funderName}
                          {f.funderIsInsider ? (
                            <Badge variant="info" className="ml-2">
                              insider
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <IsoDateText date={f.fundedOn} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={f.amount} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments by the member</CardTitle>
            </CardHeader>
            <CardContent>
              {view.payments.length === 0 ? (
                <Empty />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">To Balance</TableHead>
                      <TableHead className="text-right">To interest</TableHead>
                      <TableHead className="text-right">To costs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <IsoDateText date={p.paidOn} />
                        </TableCell>
                        <TableCell>
                          {p.source === "CASH" ? "Cash" : "Distribution offset"}
                          {p.reversesPaymentId ? " (reversal)" : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.toBalance} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.toInterest} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.toCosts} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Costs of collection</CardTitle>
            </CardHeader>
            <CardContent>
              {view.charges.length === 0 ? (
                <Empty />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.charges.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          <IsoDateText date={c.incurredOn} />
                        </TableCell>
                        <TableCell>{c.description}</TableCell>
                        <TableCell className="text-right">
                          <Money cents={c.amount} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Credits</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {view.credit.recorded ? (
                <p className="text-sm">
                  Credit Date{" "}
                  <IsoDateText date={view.credit.recorded.creditDate} />: clause
                  (A) <Money cents={view.credit.recorded.poolA} />, redirected
                  from insiders{" "}
                  <Money cents={view.credit.recorded.redirected} />, clause (B){" "}
                  <Money cents={view.credit.recorded.poolB} />
                </p>
              ) : null}
              {view.credits.length === 0 ? (
                <Empty />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Holder</TableHead>
                      <TableHead>Clause</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.credits.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>{c.name}</TableCell>
                        <TableCell>{c.clause}</TableCell>
                        <TableCell className="text-right">
                          <Money cents={c.amount} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Units micro={c.units} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function Empty() {
  return <p className="text-sm text-muted-foreground">None.</p>;
}
