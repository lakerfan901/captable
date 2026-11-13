"use client";

import { RiMore2Fill } from "@remixicon/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAllowed } from "@/hooks/use-allowed";
import { formatDateOnly } from "@/lib/date-only";
import {
  isSyncClosure,
  LEDGER_COMPLETION_NOTE,
} from "@/lib/governance/compliance-core";
import { api } from "@/trpc/react";
import {
  type ComplianceRow,
  EditDeadlineDialog,
  errorText,
  MarkDoneDialog,
  NotApplicableDialog,
} from "./compliance-dialogs";

// Compliance calendar (03-governance.md G15): four groups (Overdue, Next 30
// days, Later, Completed and not applicable), each ordered by due date under
// month sub-headings. Grouping uses the server's `daysLeft` (computed in the
// company's time zone), never the browser's clock.

const SOURCE_LABEL: Record<string, string> = {
  RULE: "Rule",
  ECONOMICS: "Ledger",
  RESOLUTION: "Resolution",
  TRANSFER: "Transfer",
  MANUAL: "Manual",
};

const MONTH = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

function monthLabel(dueOn: string): string {
  return MONTH.format(new Date(`${dueOn.slice(0, 7)}-01T00:00:00Z`));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function relativeText(daysLeft: number): string {
  if (daysLeft < 0) return `${plural(-daysLeft, "day")} overdue`;
  if (daysLeft === 0) return "due today";
  return `in ${plural(daysLeft, "day")}`;
}

/** Period of a report-backed rule deadline, from its dedupe key. */
function reportShortcut(
  row: ComplianceRow,
):
  | { type: "QUARTERLY"; fiscalYear: number; fiscalQuarter: number }
  | { type: "ANNUAL" | "TAX_K1"; fiscalYear: number }
  | null {
  if (row.source !== "RULE") return null;
  const q = /^QUARTERLY_REPORT:(\d{4})Q([1-4])$/.exec(row.dedupeKey);
  if (row.ruleKey === "QUARTERLY_REPORT" && q) {
    return {
      type: "QUARTERLY",
      fiscalYear: Number(q[1]),
      fiscalQuarter: Number(q[2]),
    };
  }
  const y = /^[A-Z0-9_]+:(\d{4})$/.exec(row.dedupeKey);
  if (!y) return null;
  if (row.ruleKey === "ANNUAL_FINANCIALS") {
    return { type: "ANNUAL", fiscalYear: Number(y[1]) };
  }
  if (row.ruleKey === "K1_TARGET" || row.ruleKey === "K1_FINAL") {
    return { type: "TAX_K1", fiscalYear: Number(y[1]) };
  }
  return null;
}

function SatisfiedCell({ row }: { row: ComplianceRow }) {
  if (row.status === "OPEN") {
    return row.description ? (
      <span className="text-muted-foreground">{row.description}</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  if (isSyncClosure(row)) {
    return (
      <span className="text-muted-foreground">
        {row.note === LEDGER_COMPLETION_NOTE
          ? "Closed by the ledger"
          : `Closed by the ledger. ${row.note ?? ""}`}
      </span>
    );
  }
  const sb = row.satisfiedBy;
  return (
    <div className="space-y-0.5">
      {sb ? (
        sb.href ? (
          <Link className="underline" href={sb.href}>
            {sb.label}
          </Link>
        ) : (
          <span>{sb.label}</span>
        )
      ) : row.status === "DONE" ? (
        <span>Other</span>
      ) : null}
      {row.note ? <p className="text-muted-foreground">{row.note}</p> : null}
    </div>
  );
}

function StatusCell({ row }: { row: ComplianceRow }) {
  if (row.status === "DONE") return <Badge variant="success">Done</Badge>;
  if (row.status === "NOT_APPLICABLE") {
    return <Badge variant="outline">Not applicable</Badge>;
  }
  return null;
}

type DialogKind = "done" | "na" | "edit";

function RowActions({
  row,
  companyPublicId,
}: {
  row: ComplianceRow;
  companyPublicId: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const createReport = api.memberReport.create.useMutation();
  const reopen = api.compliance.reopen.useMutation();
  const { isAllowed: canUpdate } = useAllowed({
    subject: "governance",
    action: "update",
  });
  const { isAllowed: canCreate } = useAllowed({
    subject: "governance",
    action: "create",
  });

  const open = row.status === "OPEN";
  const shortcut = open ? reportShortcut(row) : null;
  const termExtension = open && row.ruleKey === "EXTENSION_REQUEST_DUE";
  const transfer = open && row.source === "TRANSFER";
  const canEdit = open && (row.canEditTitle || row.canEditDueOn);
  const canReopen = !open && !isSyncClosure(row);

  const onCreateReport = async () => {
    if (!shortcut || createReport.isPending) return;
    try {
      const res = await createReport.mutateAsync({
        ...shortcut,
        relatedType: "COMPLIANCE_DEADLINE",
        relatedId: row.id,
      });
      router.push(`/${companyPublicId}/reports/${res.publicId}`);
    } catch (e) {
      toast.error(errorText(e, "The report could not be created."));
    }
  };

  const onReopen = async () => {
    if (reopen.isPending) return;
    try {
      await reopen.mutateAsync({ id: row.id });
      toast.success("Deadline reopened.");
      router.refresh();
    } catch (e) {
      toast.error(errorText(e, "The deadline could not be reopened."));
    }
  };

  const hasItems =
    (canUpdate && (open || canReopen)) ||
    (canCreate && (shortcut !== null || termExtension)) ||
    transfer;
  if (!hasItems) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Actions">
            <RiMore2Fill className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <Allow subject="governance" action="create">
            {shortcut ? (
              <DropdownMenuItem
                disabled={createReport.isPending}
                onSelect={() => void onCreateReport()}
              >
                {createReport.isPending ? "Creating report…" : "Create report"}
              </DropdownMenuItem>
            ) : null}
            {termExtension ? (
              <DropdownMenuItem asChild>
                <Link href={`/${companyPublicId}/resolutions/new`}>
                  Create term-extension resolution
                </Link>
              </DropdownMenuItem>
            ) : null}
          </Allow>
          {transfer ? (
            <DropdownMenuItem asChild>
              <Link href={`/${companyPublicId}/transfers`}>Open transfers</Link>
            </DropdownMenuItem>
          ) : null}
          <Allow subject="governance" action="update">
            {open ? (
              <>
                {shortcut || termExtension || transfer ? (
                  <DropdownMenuSeparator />
                ) : null}
                <DropdownMenuItem onSelect={() => setDialog("done")}>
                  Mark done
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("na")}>
                  Not applicable
                </DropdownMenuItem>
                {canEdit ? (
                  <DropdownMenuItem onSelect={() => setDialog("edit")}>
                    Edit
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : canReopen ? (
              <DropdownMenuItem
                disabled={reopen.isPending}
                onSelect={() => void onReopen()}
              >
                Reopen
              </DropdownMenuItem>
            ) : null}
          </Allow>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && canUpdate ? (
        <>
          <MarkDoneDialog
            row={row}
            open={dialog === "done"}
            onOpenChange={(o) => setDialog(o ? "done" : null)}
          />
          <NotApplicableDialog
            row={row}
            open={dialog === "na"}
            onOpenChange={(o) => setDialog(o ? "na" : null)}
          />
          {canEdit ? (
            <EditDeadlineDialog
              row={row}
              open={dialog === "edit"}
              onOpenChange={(o) => setDialog(o ? "edit" : null)}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function GroupTable({
  rows,
  companyPublicId,
  closed,
}: {
  rows: ComplianceRow[];
  companyPublicId: string;
  closed: boolean;
}) {
  const months: { key: string; rows: ComplianceRow[] }[] = [];
  for (const r of rows) {
    const key = r.dueOn.slice(0, 7);
    const last = months[months.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else months.push({ key, rows: [r] });
  }

  return (
    <Card>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-36">Due</TableHead>
            <TableHead>Item</TableHead>
            <TableHead className="w-40">Section</TableHead>
            <TableHead className="w-24">Source</TableHead>
            <TableHead className="w-64">
              {closed ? "Satisfied by" : "Notes"}
            </TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {months.map((m) => (
            <Fragment key={m.key}>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell
                  colSpan={6}
                  className="py-1.5 text-xs font-medium text-muted-foreground"
                >
                  {monthLabel(`${m.key}-01`)}
                </TableCell>
              </TableRow>
              {m.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <div>{formatDateOnly(r.dueOn)}</div>
                    {r.status === "OPEN" ? (
                      <div
                        className={`text-xs ${
                          r.daysLeft < 0
                            ? "font-medium text-red-600"
                            : "text-muted-foreground"
                        }`}
                      >
                        {relativeText(r.daysLeft)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div>{r.title}</div>
                    {closed ? (
                      <div className="mt-1">
                        <StatusCell row={r} />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {r.section ? `Section ${r.section}` : "—"}
                  </TableCell>
                  <TableCell>{SOURCE_LABEL[r.source] ?? r.source}</TableCell>
                  <TableCell className="break-words text-sm">
                    <SatisfiedCell row={r} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions row={r} companyPublicId={companyPublicId} />
                  </TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Group({
  title,
  rows,
  companyPublicId,
  tone,
  closed = false,
}: {
  title: string;
  rows: ComplianceRow[];
  companyPublicId: string;
  tone?: "danger";
  closed?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h4
        className={`text-sm font-medium ${tone === "danger" ? "text-red-600" : ""}`}
      >
        {title} <span className="text-muted-foreground">({rows.length})</span>
      </h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <div
          className={
            tone === "danger" ? "rounded-lg ring-1 ring-red-300" : undefined
          }
        >
          <GroupTable
            rows={rows}
            companyPublicId={companyPublicId}
            closed={closed}
          />
        </div>
      )}
    </section>
  );
}

export function ComplianceTable({
  rows,
  companyPublicId,
}: {
  /** `compliance.list({ includeClosed: true })`, ordered by due date. */
  rows: ComplianceRow[];
  companyPublicId: string;
}) {
  const [showClosed, setShowClosed] = useState(false);

  const openRows = rows.filter((r) => r.status === "OPEN");
  const overdue = openRows.filter((r) => r.daysLeft < 0);
  const next30 = openRows.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 30);
  const later = openRows.filter((r) => r.daysLeft > 30);
  const closed = rows.filter((r) => r.status !== "OPEN");

  return (
    <div className="space-y-6">
      <Group
        title="Overdue"
        rows={overdue}
        companyPublicId={companyPublicId}
        tone="danger"
      />
      <Group
        title="Next 30 days"
        rows={next30}
        companyPublicId={companyPublicId}
      />
      <Group title="Later" rows={later} companyPublicId={companyPublicId} />
      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-medium">
            Completed and not applicable{" "}
            <span className="text-muted-foreground">({closed.length})</span>
          </h4>
          {closed.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showClosed}
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed ? "Hide" : "Show"}
            </Button>
          ) : null}
        </div>
        {closed.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here.</p>
        ) : showClosed ? (
          <GroupTable rows={closed} companyPublicId={companyPublicId} closed />
        ) : null}
      </section>
    </div>
  );
}
