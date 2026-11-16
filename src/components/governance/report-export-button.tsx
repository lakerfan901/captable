"use client";

import { RiFileExcel2Line } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { downloadBase64, XLSX_MIME } from "@/components/common/download-bytes";
import { Button } from "@/components/ui/button";
import { refusalAction, trpcErrorCode } from "@/lib/portal/portal-files-view";
import { api } from "@/trpc/react";

// "Download Excel" for a quarterly or annual report (04-investor-portal.md
// 5.7). Team mode calls `memberReport.exportXlsx` (a draft downloads with
// DRAFT in its title block). Portal mode (package P8b) calls
// `portal.reports.exportXlsx` from the browser, so the `REPORT_EXPORTED` log
// row carries the client's address; it is rendered only when
// `portal.reports.get` says the report is `exportable` (never greyed out).
// If the report is no longer visible (unpublished, recipient removed, access
// turned off), the page is re-rendered and shows "not available".

export type ReportExportButtonProps =
  | { mode: "team"; publicId: string }
  | { mode: "portal"; access: string; reportId: string };

export function ReportExportButton(props: ReportExportButtonProps) {
  return props.mode === "portal" ? (
    <PortalExportButton access={props.access} reportId={props.reportId} />
  ) : (
    <TeamExportButton publicId={props.publicId} />
  );
}

function ExportButtonView(props: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={props.busy}
      onClick={props.onClick}
      data-testid="report-export-button"
    >
      <RiFileExcel2Line className="mr-1.5 h-4 w-4" aria-hidden />
      {props.busy ? "Preparing…" : (props.label ?? "Download Excel")}
    </Button>
  );
}

function TeamExportButton({ publicId }: { publicId: string }) {
  const exportXlsx = api.memberReport.exportXlsx.useMutation();
  const [busy, setBusy] = useState(false);
  return (
    <ExportButtonView
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const file = await exportXlsx.mutateAsync({ publicId });
          downloadBase64(file.fileName, file.base64, XLSX_MIME);
        } catch (e) {
          toast.error(
            e instanceof Error && e.message
              ? e.message
              : "Could not export the report.",
          );
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function PortalExportButton(props: { access: string; reportId: string }) {
  const router = useRouter();
  const exportXlsx = api.portal.reports.exportXlsx.useMutation();
  const [busy, setBusy] = useState(false);
  return (
    <ExportButtonView
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const file = await exportXlsx.mutateAsync({
            access: props.access,
            reportId: props.reportId,
          });
          downloadBase64(file.fileName, file.base64, XLSX_MIME);
        } catch (e) {
          if (refusalAction(trpcErrorCode(e)) === "reload") {
            toast.error("This report is no longer available.");
            router.refresh();
          } else {
            toast.error(
              "The Excel file could not be prepared. Please try again.",
            );
          }
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
