"use client";

import { useState } from "react";
import { IsoDateText, Money } from "@/components/llc/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateOnly } from "@/lib/date-only";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { RecordPaymentDialog } from "./record-payment-dialog";

type Line = RouterOutputs["callNotice"]["get"]["lines"][number];

type BadgeVariant =
  | "secondary"
  | "info"
  | "success"
  | "warning"
  | "destructive";

export function lineBadge(l: {
  status: Line["status"];
  overdue: boolean;
  memberDefaultId: string | null;
}): { label: string; variant: BadgeVariant } {
  if (l.status !== "PAID" && l.memberDefaultId) {
    return { label: "In default", variant: "destructive" };
  }
  if (l.overdue) return { label: "Overdue", variant: "destructive" };
  switch (l.status) {
    case "UNSENT":
      return { label: "Unsent", variant: "secondary" };
    case "SENT":
      return { label: "Sent", variant: "info" };
    case "SENDING":
      return { label: "Sending", variant: "warning" };
    case "SEND_FAILED":
      return { label: "Send failed", variant: "destructive" };
    case "PAID":
      return { label: "Paid", variant: "success" };
  }
}

export function LineTable({
  noticeId,
  lines,
  today,
  canPreview,
  canRecordPayment,
}: {
  noticeId: string;
  lines: Line[];
  today: string;
  canPreview: boolean;
  canRecordPayment: boolean;
}) {
  const [preview, setPreview] = useState<Line | null>(null);
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead className="text-right">Called</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Replacement-funded</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => {
            const b = lineBadge(l);
            const sendable =
              l.status === "UNSENT" || l.status === "SEND_FAILED";
            return (
              <TableRow key={l.lineId}>
                <TableCell className="font-medium">
                  {l.name}
                  {l.sentToEmail ? (
                    <div className="text-xs text-muted-foreground">
                      {l.sentToEmail}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={l.amountCalled} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={l.allocated} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={l.replacementFunded} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={l.outstanding} />
                </TableCell>
                <TableCell>
                  <IsoDateText date={l.dueOn} />
                </TableCell>
                <TableCell>
                  <Badge variant={b.variant}>{b.label}</Badge>
                </TableCell>
                <TableCell className="flex justify-end gap-2">
                  {canPreview && sendable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPreview(l)}
                    >
                      Preview email
                    </Button>
                  ) : null}
                  {canRecordPayment &&
                  l.status === "SENT" &&
                  l.outstanding > 0 &&
                  !l.memberDefaultId ? (
                    <RecordPaymentDialog
                      commitmentId={l.commitmentId}
                      memberName={l.name}
                      outstanding={l.outstanding}
                      today={today}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {preview ? (
        <PreviewDialog
          noticeId={noticeId}
          line={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </Card>
  );
}

function PreviewDialog({
  noticeId,
  line,
  onClose,
}: {
  noticeId: string;
  line: Line;
  onClose: () => void;
}) {
  const q = api.callNotice.preview.useQuery(
    { id: noticeId, commitmentId: line.commitmentId },
    { retry: false, refetchOnWindowFocus: false },
  );
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Preview: {line.name}</DialogTitle>
          <DialogDescription>
            {q.data
              ? `${q.data.subject} — as if sent now (due date ${formatDateOnly(q.data.dueOn)}). The account number is masked in this preview only.`
              : "The email as it would be sent now."}
          </DialogDescription>
        </DialogHeader>
        {q.error ? (
          <p className="text-sm text-destructive">{q.error.message}</p>
        ) : q.data ? (
          <iframe
            title="Call Notice email preview"
            sandbox=""
            srcDoc={q.data.html}
            className="h-[60vh] w-full rounded border bg-white"
          />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
