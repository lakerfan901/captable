"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";
import type { DistributionStatusValue } from "./distribution-table";
import { MarkPaidDialog } from "./mark-paid-dialog";

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
 * (`distributions: update` to send / mark paid, `read` to export).
 */
export function DistributionActions({
  distributionId,
  status,
}: {
  distributionId: string;
  status: DistributionStatusValue;
}) {
  const router = useRouter();
  const enabled = status === "FINALIZED";
  const query = api.distribution.get.useQuery(
    { id: distributionId },
    { enabled },
  );
  const send = api.distribution.sendNotices.useMutation();
  const exportCsv = api.distribution.exportCsv.useMutation();

  const data = query.data;
  if (!enabled || !data || data.distribution.isReversal) return null;

  const unsent = data.lines.filter(
    (l) => l.noticeSentAt === null && l.grossCents > 0,
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

  return (
    <>
      <Button
        variant="outline"
        onClick={onSend}
        disabled={send.isPending || unsent.length === 0}
        loading={send.isPending}
      >
        {unsent.length === 0
          ? "Notices sent"
          : `Send notices (${unsent.length})`}
      </Button>
      <Button
        variant="outline"
        onClick={onExport}
        disabled={exportCsv.isPending}
        loading={exportCsv.isPending}
      >
        Export payment list (CSV)
      </Button>
      {payable.length > 0 ? (
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
