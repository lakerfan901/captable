import { IsoDateText } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
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
import { daysBetween } from "@/lib/llc/dates";
import type { RouterOutputs } from "@/trpc/shared";

type TermClock = RouterOutputs["llcTerm"]["get"]["clock"];

type Kind = "deadline" | "milestone";

function StatusBadge({
  date,
  today,
  kind,
  done,
}: {
  date: string | null;
  today: string;
  kind: Kind;
  done?: boolean;
}) {
  if (date === null) return <Badge variant="outline">Not set</Badge>;
  if (done) return <Badge variant="success">Done</Badge>;
  const days = daysBetween(today, date);
  if (kind === "milestone") {
    if (days <= 0) return <Badge variant="success">Passed</Badge>;
    return <Badge variant="info">In {days} days</Badge>;
  }
  if (days < 0) {
    return (
      <Badge variant="destructive">
        Overdue by {-days} {-days === 1 ? "day" : "days"}
      </Badge>
    );
  }
  if (days === 0) return <Badge variant="warning">Due today</Badge>;
  return (
    <Badge variant={days <= 30 ? "warning" : "info"}>
      Due in {days} {days === 1 ? "day" : "days"}
    </Badge>
  );
}

export function TermClockCard({
  clock,
  today,
  ocdNoticeSentOn,
}: {
  clock: TermClock;
  today: string;
  ocdNoticeSentOn: string | null;
}) {
  const rows: {
    label: string;
    section: string;
    date: string | null;
    kind: Kind;
    done?: boolean;
  }[] = [
    {
      label: "Operations Commencement Date",
      section: "1.21",
      date: clock.operationsCommencementDate,
      kind: "milestone",
    },
    {
      label: "Notice of the Operations Commencement Date due",
      section: "1.21",
      date: clock.ocdNoticeDueOn,
      kind: "deadline",
      done: ocdNoticeSentOn !== null,
    },
    {
      label: "Target Sale Date (fifth anniversary)",
      section: "2.4",
      date: clock.baseTargetSaleDate,
      kind: "milestone",
    },
    {
      label: "Target Sale Date after approved extensions",
      section: "2.4",
      date: clock.extendedTargetSaleDate,
      kind: "milestone",
    },
    {
      label: "Effective Target Sale Date (including LOI extension)",
      section: "2.4",
      date: clock.effectiveTargetSaleDate,
      kind: "milestone",
    },
    {
      label: "Extension request due",
      section: "2.5",
      date: clock.extensionRequestDueOn,
      kind: "deadline",
    },
    {
      label: "Target Sale Date if one more extension is approved",
      section: "2.4",
      date: clock.nextExtensionTargetSaleDate,
      kind: "milestone",
    },
    {
      label: "Latest date of an LOI extension",
      section: "2.4",
      date: clock.loiExtensionMaxDate,
      kind: "milestone",
    },
    {
      label: "Dissolution election available after",
      section: "11.1(d)",
      date: clock.dissolutionElectionAvailableAfter,
      kind: "milestone",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Term clock</CardTitle>
        <CardDescription>
          {clock.extensionsApproved}{" "}
          {clock.extensionsApproved === 1 ? "extension" : "extensions"}{" "}
          approved. Today is <IsoDateText date={today} />.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {clock.operationsCommencementDate === null ? (
          <p className="text-sm text-muted-foreground">
            Operations Commencement Date not set.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Section</TableHead>
                <TableHead>On</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell>§{row.section}</TableCell>
                  <TableCell>
                    <IsoDateText date={row.date} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      date={row.date}
                      today={today}
                      kind={row.kind}
                      done={row.done}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
