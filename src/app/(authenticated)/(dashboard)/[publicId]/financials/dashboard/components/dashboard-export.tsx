"use client";

import { toast } from "sonner";
import { downloadBase64, XLSX_MIME } from "@/components/common/download-bytes";
import { DashboardExportMenu } from "@/components/financials/export-menu";
import { printHref } from "@/components/financials/export-request";
import type { SourceState } from "@/components/financials/team-dashboard-model";
import type { FinancialsExportView } from "@/lib/xlsx/financials-export-input";
import { api } from "@/trpc/react";

// The export menu of the team's financial dashboard (04-investor-portal.md
// 6.3; package P17): the view on screen from the active source. Live and
// Published export the fund view; Preview exports what the previewed holder
// sees, its "My investment" section included (`asHolder`, which the server
// allows only with `portal: read`).

export function TeamDashboardExport({
  src,
  request,
}: {
  src: SourceState;
  request: FinancialsExportView;
}) {
  const exportXlsx = api.financialDashboard.exportXlsx.useMutation();
  return (
    <DashboardExportMenu
      onExcel={async () => {
        try {
          const file = await exportXlsx.mutateAsync({
            ...request,
            source: src.source === "live" ? "live" : "published",
            ...(src.source === "preview" && src.holder !== null
              ? { asHolder: src.holder }
              : {}),
          });
          downloadBase64(file.fileName, file.base64, XLSX_MIME);
        } catch (e) {
          toast.error(
            e instanceof Error && e.message
              ? e.message
              : "The Excel file could not be prepared.",
          );
        }
      }}
      printPath={() =>
        printHref(window.location.pathname, window.location.search)
      }
    />
  );
}
