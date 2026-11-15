import { RiMailLine } from "@remixicon/react";
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
import { plural, reportChip } from "@/lib/governance/release-view";
import type { RouterOutputs } from "@/trpc/shared";
import { reportTypeLabel } from "./report-view";

// Member report list (03-governance.md G13; 04-investor-portal.md 6.2:
// Draft / Released / Unpublished, a mail icon when emailed). Server-safe.

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

/** Draft, Released or Unpublished (04-investor-portal.md 6.2). */
export function ReportStatusBadge({
  status,
  unpublishedAt = null,
}: {
  status: string;
  unpublishedAt?: Date | string | null;
}) {
  const chip = reportChip({ status, publishedAt: null, unpublishedAt });
  return <Badge variant={chip.variant}>{chip.label}</Badge>;
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
            <TableHead>Released</TableHead>
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
                  <div className="flex items-center gap-2">
                    <ReportStatusBadge
                      status={r.status}
                      unpublishedAt={r.unpublishedAt}
                    />
                    {r.emailedCount > 0 ? (
                      <span
                        className="text-muted-foreground"
                        title={`Emailed to ${r.emailedCount} of ${plural(r.recipientCount, "recipient", "recipients")}`}
                      >
                        <span className="sr-only">
                          Emailed to {r.emailedCount} of {r.recipientCount}
                        </span>
                        <RiMailLine className="h-4 w-4" aria-hidden />
                      </span>
                    ) : null}
                  </div>
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
