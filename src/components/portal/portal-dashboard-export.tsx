"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { downloadBase64, XLSX_MIME } from "@/components/common/download-bytes";
import { DashboardExportMenu } from "@/components/financials/export-menu";
import { printHref } from "@/components/financials/export-request";
import { refusalAction, trpcErrorCode } from "@/lib/portal/portal-files-view";
import { accessBasePath } from "@/lib/portal/portal-nav";
import type { FinancialsExportView } from "@/lib/xlsx/financials-export-input";
import { api } from "@/trpc/react";

// The export menu of the investor's Financials and My investment pages
// (04-investor-portal.md 6.3; package P17). Excel calls
// `portal.financials.exportXlsx` from the browser, so the
// `FINANCIALS_EXPORTED` log row carries the client's address. When the
// figures are no longer available (unpublished, access turned off, signed
// out), the page is re-rendered and shows what is visible now.

export function PortalDashboardExport({
  access,
  page,
  request,
}: {
  access: string;
  page: "financials" | "investment";
  request: FinancialsExportView;
}) {
  const router = useRouter();
  const exportXlsx = api.portal.financials.exportXlsx.useMutation();
  return (
    <DashboardExportMenu
      onExcel={async () => {
        try {
          const file = await exportXlsx.mutateAsync({ access, ...request });
          downloadBase64(file.fileName, file.base64, XLSX_MIME);
        } catch (e) {
          if (refusalAction(trpcErrorCode(e)) === "reload") {
            toast.error("These figures are no longer available.");
            router.refresh();
          } else {
            toast.error(
              "The Excel file could not be prepared. Please try again.",
            );
          }
        }
      }}
      printPath={() =>
        printHref(`${accessBasePath(access)}/${page}`, window.location.search)
      }
    />
  );
}
