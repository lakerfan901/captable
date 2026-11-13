import { IsoDateText, Money } from "@/components/llc/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";
import { DeclareDialog } from "./declare-dialog";

export type OverdueLine =
  RouterOutputs["memberDefault"]["overdue"]["lines"][number];

export function OverdueTable({
  lines,
  canDeclare,
}: {
  lines: OverdueLine[];
  canDeclare: boolean;
}) {
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">No overdue lines.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Notice</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="text-right">Unpaid at due date</TableHead>
          <TableHead className="text-right">Outstanding</TableHead>
          <TableHead className="text-right">Interest to date</TableHead>
          <TableHead>Forfeiture Date</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.lineId}>
            <TableCell className="font-medium">{l.name}</TableCell>
            <TableCell>No. {l.callNoticeNumber}</TableCell>
            <TableCell>
              <IsoDateText date={l.dueOn} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={l.unpaidAtDue} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={l.outstanding} />
            </TableCell>
            <TableCell className="text-right">
              <Money cents={l.interestToDate} />
            </TableCell>
            <TableCell>
              <IsoDateText date={l.forfeitureDate} />
            </TableCell>
            <TableCell className="text-right">
              {canDeclare ? <DeclareDialog line={l} /> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
