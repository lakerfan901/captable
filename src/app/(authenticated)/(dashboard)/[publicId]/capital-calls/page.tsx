import { RiMailSendLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/common/empty-state";
import { Money } from "@/components/llc/money";
import { Button } from "@/components/ui/button";
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
import { NoticeTable, OverdueTable } from "./components/notice-table";
import { OutsideDateBanner } from "./components/outside-date-banner";

export const metadata: Metadata = { title: "Capital calls" };

export default async function CapitalCallsPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const list = await allow(api.callNotice.list(), ["capital-calls", "read"]);
  if (!list) return <UnAuthorizedState />;
  const eligible = await api.callNotice.eligible();
  const overdue = await api.callNotice.overdue();
  const canCreate = allow(true, ["capital-calls", "create"], false);
  const base = `/${entity.publicId}/capital-calls`;

  const states = eligible.states;
  const committed = states.reduce((s, c) => s + c.acceptedCents, 0);
  const paid = states.reduce((s, c) => s + c.totalPaid, 0);
  const uncalled = states.reduce((s, c) => s + c.uncalled, 0);
  const outstanding = list.notices
    .filter((n) => n.status !== "CANCELLED")
    .reduce((s, n) => s + n.totalOutstanding, 0);
  const outsideRecorded = list.notices.some(
    (n) => n.kind === "OUTSIDE_DATE" && n.status !== "CANCELLED",
  );
  const showBanner =
    eligible.outsideDate !== null &&
    eligible.today >= eligible.outsideDate &&
    uncalled > 0 &&
    !outsideRecorded;

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-medium">Capital calls</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A Call Notice demands part or all of each member&apos;s uncalled
            Balance, due three business days after it is sent and in any event
            not later than the Balance outside date (Section 4.9).
          </p>
        </div>
        {canCreate && eligible.proposedDueOn !== null ? (
          <Button asChild>
            <Link href={`${base}/new`}>New Call Notice</Link>
          </Button>
        ) : null}
      </div>

      {showBanner && eligible.outsideDate ? (
        <OutsideDateBanner
          outsideDate={eligible.outsideDate}
          canCreate={canCreate}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Committed" value={<Money cents={committed} />} />
        <Stat label="Paid" value={<Money cents={paid} />} />
        <Stat label="Uncalled Balance" value={<Money cents={uncalled} />} />
        <Stat
          label="Called and outstanding"
          value={<Money cents={outstanding} />}
        />
        <Stat label="Overdue lines" value={overdue.lines.length} />
      </div>

      {list.notices.length === 0 ? (
        <EmptyState
          icon={<RiMailSendLine />}
          title="No Call Notices yet"
          subtitle="Create a Call Notice to call the Balance of the members' commitments."
        />
      ) : (
        <NoticeTable notices={list.notices} base={base} />
      )}

      {overdue.lines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Overdue lines</CardTitle>
            <CardDescription>
              Lines not paid in full by their due date. Nothing happens
              automatically: review each one and decide whether to declare a
              default.{" "}
              <Link className="underline" href={`${base}/defaults`}>
                Open the default workflow
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OverdueTable lines={overdue.lines} base={base} />
          </CardContent>
        </Card>
      ) : null}
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
