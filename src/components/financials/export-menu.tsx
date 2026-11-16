"use client";

import {
  RiArrowDownSLine,
  RiDownload2Line,
  RiFileExcel2Line,
  RiPrinterLine,
} from "@remixicon/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The dashboard's export menu (04-investor-portal.md 6.3 "Export menu";
 * package P17), in the period control row: "Excel workbook" downloads the
 * view on screen, "Print or save as PDF" opens the print layout of the same
 * view in a new tab, which calls the browser's print dialog. The caller
 * renders it only for a viewer who may export (never greyed out).
 */
export function DashboardExportMenu({
  onExcel,
  printPath,
}: {
  /** builds and downloads the workbook; rejects with a message to show */
  onExcel: () => Promise<void>;
  /** the print route with the page's query, opened in a new tab */
  printPath: () => string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          data-testid="dashboard-export"
        >
          <RiDownload2Line className="mr-1.5 h-4 w-4" aria-hidden />
          {busy ? "Preparing…" : "Export"}
          <RiArrowDownSLine className="ml-1 h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-testid="dashboard-export-excel"
          onSelect={async () => {
            setBusy(true);
            try {
              await onExcel();
            } finally {
              setBusy(false);
            }
          }}
        >
          <RiFileExcel2Line className="mr-2 h-4 w-4" aria-hidden />
          Excel workbook (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="dashboard-export-print"
          onSelect={() => {
            window.open(printPath(), "_blank", "noopener");
          }}
        >
          <RiPrinterLine className="mr-2 h-4 w-4" aria-hidden />
          Print or save as PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
