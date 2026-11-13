import Link from "next/link";
import { Badge } from "@/components/ui/badge";
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
import type { RouterOutputs } from "@/trpc/shared";
import { reportTypeLabel } from "./report-view";

// Member report list (03-governance.md G13). Server-safe (no hooks).

export type ReportRow = RouterOutputs["memberReport"]["list"][number];

export function reportPeriodShort(r: {
  type: string;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
}): string {
  if (r.type === "QUARTERLY" && r.fiscalYear && r.fiscalQuarter) {
    return `Q${r.fiscalQuarter} ${r.fiscalYear}`;
  }
  if ((r.type === "ANNUAL" || r.type === "TAX_K1") && r.fiscalYear) {
    return `FY${r.fiscalYear}`;
  }
  return "—";
}

export function ReportStatusBadge({ status }: { status: string }) {
  return status === "SENT" ? (
    <Badge variant="success">Sent</Badge>
  ) : (
    <Badge variant="warning">Draft</Badge>
  );
}

function formatInstantDate(at: Date | string | null, timeZone: string) {
  if (at === null) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
  }).format(d);
}

export function ReportTable({
  rows,
  base,
  timeZone,
  today,
}: {
  rows: ReportRow[];
  /** `/<companyPublicId>/reports` */
  base: string;
  timeZone: string;
  /** Today in the company time zone (`YYYY-MM-DD`). */
  today: string;
}) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Viewed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const overdue =
              r.status !== "SENT" && r.dueOn !== null && r.dueOn < today;
            return (
              <TableRow key={r.publicId}>
                <TableCell className="font-medium">
                  <Link className="underline" href={`${base}/${r.publicId}`}>
                    {r.title}
                  </Link>
                </TableCell>
                <TableCell>{reportTypeLabel(r.type, r.noticeKind)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {reportPeriodShort(r)}
                </TableCell>
                <TableCell
                  className={`whitespace-nowrap ${overdue ? "font-medium text-red-600" : ""}`}
                >
                  {r.dueOn ? formatDateOnly(r.dueOn) : "—"}
                  {overdue ? " (overdue)" : ""}
                </TableCell>
                <TableCell>
                  <ReportStatusBadge status={r.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstantDate(r.sentAt, timeZone)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {r.status === "SENT"
                    ? `${r.viewedCount}/${r.recipientCount}`
                    : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
