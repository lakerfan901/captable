import Link from "next/link";
import { IsoDateText, Money } from "@/components/llc/money";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";

type DefaultRow = RouterOutputs["memberDefault"]["list"]["defaults"][number];
export type DefaultStage = DefaultRow["stage"];
type Action = DefaultRow["actions"][number];

const STAGE: Record<
  DefaultStage,
  { label: string; variant: BadgeProps["variant"] }
> = {
  DECLARED: { label: "Declared", variant: "warning" },
  FORFEITURE_DUE: { label: "Forfeiture due", variant: "destructive" },
  IN_SUSPENSE: { label: "In suspense", variant: "warning" },
  CREDIT_DUE: { label: "Credit due", variant: "destructive" },
  CREDITED: { label: "Credited", variant: "info" },
  CURE_AVAILABLE: { label: "Cure available", variant: "info" },
  CURED: { label: "Cured", variant: "success" },
  VOIDED: { label: "Voided", variant: "secondary" },
};

export const ACTION_LABEL: Record<Action["action"], string> = {
  CONFIRM_FORFEITURE: "Confirm forfeiture",
  CONFIRM_CREDIT: "Confirm credit",
  CONFIRM_CURE: "Confirm cure",
};

export function StageBadge({ stage }: { stage: DefaultStage }) {
  const s = STAGE[stage];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function DefaultTable({
  defaults,
  base,
}: {
  defaults: DefaultRow[];
  base: string;
}) {
  if (defaults.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No defaults declared.</p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="text-right">Outstanding Balance</TableHead>
          <TableHead className="text-right">Interest owed</TableHead>
          <TableHead className="text-right">Costs owed</TableHead>
          <TableHead>Stage</TableHead>
          <TableHead>Next action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {defaults.map((d) => {
          const next = d.actions[0];
          return (
            <TableRow key={d.id}>
              <TableCell className="font-medium">
                <Link className="underline" href={`${base}/${d.id}`}>
                  {d.memberName}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">
                  No. {d.callNoticeNumber}
                </span>
              </TableCell>
              <TableCell>
                <IsoDateText date={d.dueOn} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={d.outstandingBalance} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={d.interestOwed} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={d.costsOwed} />
              </TableCell>
              <TableCell>
                <StageBadge stage={d.stage} />
              </TableCell>
              <TableCell>
                {next ? (
                  <span>
                    {ACTION_LABEL[next.action]}{" "}
                    <span className="text-muted-foreground">
                      {next.available ? "now" : "from "}
                      {next.available ? null : (
                        <IsoDateText date={next.availableOn} />
                      )}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
