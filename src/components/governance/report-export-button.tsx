"use client";

import { RiFileExcel2Line } from "@remixicon/react";
import { useState } from "react";
import { toast } from "sonner";
import { downloadBase64, XLSX_MIME } from "@/components/common/download-bytes";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";

// "Download Excel" for a quarterly or annual report (04-investor-portal.md
// 5.7). Team mode calls `memberReport.exportXlsx` (a draft downloads with
// DRAFT in its title block). The portal mode (`portal.reports.exportXlsx`)
// needs the portal procedure base (P2) and the report visibility rule (P5),
// and is added here by the package that implements that procedure.

export interface ReportExportButtonProps {
  mode: "team";
  publicId: string;
}

export function ReportExportButton({ publicId }: ReportExportButtonProps) {
  const exportXlsx = api.memberReport.exportXlsx.useMutation();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
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
    >
      <RiFileExcel2Line className="mr-1.5 h-4 w-4" aria-hidden />
      {busy ? "Preparing…" : "Download Excel"}
    </Button>
  );
}
