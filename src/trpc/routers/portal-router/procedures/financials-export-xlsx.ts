// portal.financials.exportXlsx (04-investor-portal.md 5.4, 5.9 "Export of
// the current view", P33, S30; package P17).
//
// The Excel workbook of the view on the investor's Financials ("fund") or
// My investment ("mine") page, built from exactly the answer of
// `portal.financials.get` for the holder of the access (the same function,
// `readHolderFinancialView`): fund records and the holder's own records
// (holderId "self") through its published-through date as computed now.
// `to` is clamped to that date; nothing published (never released,
// unpublished, the holder removed, the range outside it) is NOT_FOUND and
// writes no log row. On success one `FINANCIALS_EXPORTED` row, targetType
// "financials" with the view as its name. A mutation called from the
// browser, so the row carries the client's address.

import { ZFinancialsExportView } from "@/lib/xlsx/financials-export-input";
import { readHolderFinancialView } from "@/server/portal/financial-view";
import { writePortalLog } from "@/server/portal/log";
import { exportFinancialsXlsx } from "@/server/xlsx/financials-export";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export const financialsExportXlsxProcedure = investorProcedure
  .input(ZFinancialsExportView)
  .mutation(async ({ ctx, input }) => {
    const data = await readHolderFinancialView(ctx.db, ctx.holder, ctx.company);
    const file = await exportFinancialsXlsx(data, input, {
      companyName: ctx.company.name,
      source: "portal",
    });
    await writePortalLog(ctx.db, ctx, {
      event: "FINANCIALS_EXPORTED",
      targetType: "financials",
      targetName: file.caption,
    });
    return { fileName: file.fileName, base64: file.base64 };
  });
