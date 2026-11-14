"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Money } from "@/components/llc/money";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { type MailDeliveryState, TEST_MODE_TEXT } from "@/lib/mail-delivery";
import { api } from "@/trpc/react";
import type { DistributionStatusValue } from "./distribution-table";
import { MarkPaidDialog } from "./mark-paid-dialog";
import { ResendNoticesDialog } from "./resend-notices-dialog";

function downloadCsv(fileName: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * E17: member notices, payment-list CSV and payment marking for a finalized,
 * non-reversal, non-reversed distribution. The server enforces RBAC
 * (`distributions: update` to send / mark paid, `read` to export); the page
 * passes `canUpdate` so a read-only viewer sees the export only.
 */
export function DistributionActions({
  distributionId,
  status,
  canUpdate,
  mailDelivery,
}: {
  distributionId: string;
  status: DistributionStatusValue;
  /** `distributions: update` (send notices, mark paid). */
  canUpdate: boolean;
  /** Test mode / refusal of member emails (src/lib/mail-delivery.ts). */
  mailDelivery: MailDeliveryState;
}) {
  const router = useRouter();
  const enabled = status === "FINALIZED";
  const query = api.distribution.get.useQuery(
    { id: distributionId },
    { enabled },
  );
  const send = api.distribution.sendNotices.useMutation();
  const exportCsv = api.distribution.exportCsv.useMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const data = query.data;
  if (!enabled || !data || data.distribution.isReversal) return null;

  const unsent = data.lines.filter(
    (l) => l.noticeSentAt === null && l.grossCents > 0,
  );
  // Lines whose notice went out (re-send: a bounced or corrected address).
  const sentNotices = data.lines.flatMap((l) =>
    l.noticeSentAt !== null && l.grossCents > 0
      ? [
          {
            id: l.id,
            name: l.name,
            noticeAddress: l.noticeAddress,
            noticeSentAt: l.noticeSentAt,
            noticeSendCount: l.noticeSendCount,
            noticeLastSentAt: l.noticeLastSentAt,
          },
        ]
      : [],
  );
  const payable = data.lines
    .filter((l) => l.netCents > 0)
    .map((l) => ({
      id: l.id,
      name: l.name,
      netCents: l.netCents,
      paidOn: l.paidOn,
      paymentReference: l.paymentReference,
    }));

  const onSend = async () => {
    try {
      const { results } = await send.mutateAsync({ id: distributionId });
      const sent = results.filter((r) => r.status === "SENT").length;
      const failed = results.filter((r) => r.status === "FAILED");
      const skipped = results.filter((r) => r.status === "SKIPPED").length;
      if (failed.length > 0) {
        toast.error(
          `${sent} sent, ${failed.length} failed (${failed.map((f) => f.name).join(", ")}), ${skipped} skipped.`,
        );
      } else {
        toast.success(`${sent} notice(s) sent, ${skipped} skipped.`);
      }
      setConfirmOpen(false);
      await query.refetch();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const onExport = async () => {
    try {
      const { filename, csv } = await exportCsv.mutateAsync({
        id: distributionId,
      });
      downloadCsv(filename, csv);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const n = unsent.length;
  const members = `${n} ${n === 1 ? "Member" : "Members"}`;

  return (
    <>
      {canUpdate ? (
        n === 0 ? (
          <Button variant="outline" disabled>
            Notices sent
          </Button>
        ) : (
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Send notices ({n})</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  Send distribution notices to {members}?
                </DialogTitle>
                <DialogDescription>
                  Each Member below is emailed a notice of Distribution No.{" "}
                  {data.distribution.number} with their gross amount, offsets
                  and net payment. A notice cannot be recalled once sent.
                  Members without a notice email are skipped.
                </DialogDescription>
              </DialogHeader>

              {mailDelivery.blockedReason ? (
                <Alert variant="destructive">
                  <AlertTitle>Sending is blocked</AlertTitle>
                  <AlertDescription>
                    {mailDelivery.blockedReason}
                  </AlertDescription>
                </Alert>
              ) : mailDelivery.testMode ? (
                <Alert variant="destructive">
                  <AlertTitle>Test mode</AlertTitle>
                  <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
                </Alert>
              ) : null}

              <ul className="max-h-56 space-y-1 overflow-y-auto rounded border p-2 text-sm">
                {unsent.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2">
                    <span>{l.name}</span>
                    <span className="text-muted-foreground">
                      gross <Money cents={l.grossCents} />
                    </span>
                  </li>
                ))}
              </ul>

              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={onSend}
                  disabled={
                    send.isPending || mailDelivery.blockedReason !== null
                  }
                  loading={send.isPending}
                >
                  Send to {members}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )
      ) : null}
      {canUpdate && sentNotices.length > 0 ? (
        <ResendNoticesDialog
          distributionId={distributionId}
          distributionNumber={data.distribution.number}
          lines={sentNotices}
          mailDelivery={mailDelivery}
          onDone={async () => {
            await query.refetch();
            router.refresh();
          }}
        />
      ) : null}
      <Button
        variant="outline"
        onClick={onExport}
        disabled={exportCsv.isPending}
        loading={exportCsv.isPending}
      >
        Export payment list (CSV)
      </Button>
      {canUpdate && payable.length > 0 ? (
        <MarkPaidDialog
          distributionId={distributionId}
          lines={payable}
          onDone={async () => {
            await query.refetch();
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
