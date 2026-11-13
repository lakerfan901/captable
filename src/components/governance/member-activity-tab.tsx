import Link from "next/link";
import { REPORT_TYPE_LABEL } from "@/components/governance/report-view";
import {
  formatInstantDate,
  RESOLUTION_TYPE_LABEL,
} from "@/components/governance/resolution-table";
import { StatusBadge } from "@/components/governance/status-badge";
import {
  TransferStatusBadge,
  unitsText,
} from "@/components/governance/transfer-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateOnly } from "@/lib/date-only";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { displayUnits } from "@/lib/governance/transfer-core";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { getSessionEntity } from "@/server/entity";
import { api } from "@/trpc/server";
import type { RouterOutputs } from "@/trpc/shared";

// Member detail page, "Governance" tab (03-governance.md G19): the ballots
// sent to this Member, the reports and notices sent to it, and the unit
// transfers it is a party to. Commitments, economics, documents and emails
// have their own tabs.

type Activity = RouterOutputs["governance"]["memberActivity"];

function voteText(b: Activity["ballots"][number]): string {
  if (b.deemed) return "Deemed against (Section 2.5)";
  switch (b.choice) {
    case "FOR":
      return "For";
    case "AGAINST":
      return "Against";
    case "ABSTAIN":
      return "Abstain";
    default:
      return b.status === "SENT" ? "Awaiting response" : "No response";
  }
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Card>{children}</Card>
      )}
    </div>
  );
}

export async function MemberActivityTab({
  stakeholderId,
}: {
  stakeholderId: string;
}) {
  const { allow } = await serverAccessControl();
  // A thunk, so the query is not called when the caller may not read it.
  const load = allow(
    () => api.governance.memberActivity({ stakeholderId }),
    ["governance", "read"],
  );
  const data = load ? await load() : null;
  if (!data) {
    return (
      <Alert>
        <AlertDescription>
          You do not have access to governance records.
        </AlertDescription>
      </Alert>
    );
  }

  const entity = await getSessionEntity();
  const timeZone = entity.timezone || GOVERNANCE_TIME_ZONE;
  const base = `/${entity.publicId}`;
  const date = (at: Date | null) => formatInstantDate(at, timeZone);

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Resolutions"
        empty={
          data.ballots.length === 0
            ? "No resolution has been sent to this member for a vote."
            : null
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resolution</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Preferred Units</TableHead>
              <TableHead>Vote</TableHead>
              <TableHead>Submitted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.ballots.map((b) => (
              <TableRow key={b.resolutionPublicId}>
                <TableCell>
                  <Link
                    href={`${base}/resolutions/${b.resolutionPublicId}`}
                    className="font-medium hover:underline"
                  >
                    {b.referenceCode ? `${b.referenceCode} · ` : ""}
                    {b.title}
                  </Link>
                </TableCell>
                <TableCell>
                  {RESOLUTION_TYPE_LABEL[
                    b.type as keyof typeof RESOLUTION_TYPE_LABEL
                  ] ?? b.type}
                </TableCell>
                <TableCell>
                  <StatusBadge status={b.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {displayUnits(b.preferredUnits)}
                </TableCell>
                <TableCell>{voteText(b)}</TableCell>
                <TableCell>{date(b.submittedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Reports and notices"
        empty={
          data.reports.length === 0
            ? "No report or notice has been sent to this member."
            : null
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Report</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>First opened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.reports.map((r) => (
              <TableRow key={r.reportPublicId}>
                <TableCell>
                  <Link
                    href={`${base}/reports/${r.reportPublicId}`}
                    className="font-medium hover:underline"
                  >
                    {r.title}
                  </Link>
                </TableCell>
                <TableCell>{REPORT_TYPE_LABEL[r.type] ?? r.type}</TableCell>
                <TableCell>{date(r.sentAt)}</TableCell>
                <TableCell>
                  {r.firstViewedAt ? date(r.firstViewedAt) : "Not opened"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="Unit transfers"
        empty={
          data.transfers.length === 0
            ? "This member is not a party to any unit transfer."
            : null
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transfer</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead>Transferee admitted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.transfers.map((t) => (
              <TableRow key={t.transferPublicId}>
                <TableCell>
                  <Link
                    href={`${base}/transfers/${t.transferPublicId}`}
                    className="font-medium hover:underline"
                  >
                    {unitsText(t.units, t.unitClassKind)}
                  </Link>
                </TableCell>
                <TableCell>
                  {t.direction === "OUT" ? "Transferred out" : "Received"}
                </TableCell>
                <TableCell>
                  <TransferStatusBadge
                    status={t.status}
                    admittedOn={t.admittedOn}
                  />
                </TableCell>
                <TableCell>
                  {t.effectiveOn ? formatDateOnly(t.effectiveOn) : "—"}
                </TableCell>
                <TableCell>
                  {t.admittedOn ? formatDateOnly(t.admittedOn) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
