import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatDay,
  periodText,
  reportTypeShort,
} from "@/lib/portal/portal-files-view";
import { accessBasePath } from "@/lib/portal/portal-nav";

// The reports table of one holder (04-investor-portal.md 6.1; approved
// prototype; package P8b): title (a link to the report page), type, period,
// date released; newest first as `portal.reports.list` returns it. Server
// component: only the report's public id, title, type and dates reach the
// page. A report without a period shows nothing in that cell.

export interface PortalReportRow {
  /** The report's public id. */
  id: string;
  title: string;
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
  releasedAt: Date | null;
}

export function reportHref(access: string, reportId: string): string {
  return `${accessBasePath(access)}/reports/${encodeURIComponent(reportId)}`;
}

export function PortalReportList(props: {
  access: string;
  reports: PortalReportRow[];
  timeZone: string;
}) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead className="hidden sm:table-cell">Type</TableHead>
            <TableHead className="hidden md:table-cell">Period</TableHead>
            <TableHead>Date released</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.reports.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="h-24 text-center text-muted-foreground"
                id="reports-empty"
              >
                No reports have been published yet.
              </TableCell>
            </TableRow>
          ) : (
            props.reports.map((r) => (
              <TableRow key={r.id} data-testid="report-row">
                <TableCell className="font-medium">
                  <Link
                    href={reportHref(props.access, r.id)}
                    className="rounded-sm underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {r.title}
                  </Link>
                  {/* On a phone the type rides under the title. */}
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground sm:hidden">
                    {reportTypeShort(r.type)}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {reportTypeShort(r.type)}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap md:table-cell">
                  {periodText(r.periodStart, r.periodEnd)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDay(r.releasedAt, props.timeZone)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
