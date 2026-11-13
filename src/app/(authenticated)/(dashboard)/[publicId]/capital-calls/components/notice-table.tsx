import Link from "next/link";
import { IsoDateText, Money } from "@/components/llc/money";
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
import type { RouterOutputs } from "@/trpc/shared";

type Notice = RouterOutputs["callNotice"]["list"]["notices"][number];
type OverdueLine = RouterOutputs["callNotice"]["overdue"]["lines"][number];

const STATUS: Record<
  Notice["status"],
  { label: string; variant: "secondary" | "info" | "success" | "outline" }
> = {
  DRAFT: { label: "Draft", variant: "secondary" },
  SENT: { label: "Sent", variant: "info" },
  SETTLED: { label: "Settled", variant: "success" },
  CANCELLED: { label: "Cancelled", variant: "outline" },
};

export const KIND_LABEL: Record<Notice["kind"], string> = {
  CALL: "Call Notice",
  OUTSIDE_DATE: "Balance due (outside date)",
};

export function NoticeStatusBadge({ status }: { status: Notice["status"] }) {
  const s = STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** Instant (not a calendar date) shown in UTC so server and browser agree. */
function SentAt({ at }: { at: Date | string | null }) {
  if (at === null) return <span>—</span>;
  const iso = (typeof at === "string" ? at : at.toISOString()).slice(0, 10);
  return <IsoDateText date={iso} />;
}

export function NoticeTable({
  notices,
  base,
}: {
  notices: Notice[];
  base: string;
}) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>No.</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Due</TableHead>
            <TableHead className="text-right">Called</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead className="text-right">Overdue</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {notices.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-medium">
                <Link className="underline" href={`${base}/${n.id}`}>
                  No. {n.number}
                </Link>
              </TableCell>
              <TableCell>{KIND_LABEL[n.kind]}</TableCell>
              <TableCell>
                <NoticeStatusBadge status={n.status} />
              </TableCell>
              <TableCell>
                <SentAt at={n.sentAt} />
              </TableCell>
              <TableCell>
                <IsoDateText date={n.earliestDueOn} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={n.totalCalled} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={n.totalOutstanding} />
              </TableCell>
              <TableCell className="text-right">
                {n.overdueCount > 0 ? (
                  <Badge variant="destructive">{n.overdueCount}</Badge>
                ) : (
                  0
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export function OverdueTable({
  lines,
  base,
}: {
  lines: OverdueLine[];
  base: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Due</TableHead>
          <TableHead>Forfeiture Date</TableHead>
          <TableHead className="text-right">Called</TableHead>
          <TableHead className="text-right">Outstanding</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.lineId}>
            <TableCell className="font-medium">
              {l.name}
              {l.memberDefaultId ? (
                <Badge variant="destructive" className="ml-2">
                  In default
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>
              <IsoDateText date={l.dueOn} />
            </TableCell>
            <TableCell>
              <IsoDateText date={l.forfeitureDate} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={l.amountCalled} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={l.outstanding} />
            </TableCell>
            <TableCell className="text-right">
              <Link
                className="underline"
                href={
                  l.memberDefaultId
                    ? `${base}/defaults/${l.memberDefaultId}`
                    : `${base}/defaults`
                }
              >
                Review default
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
