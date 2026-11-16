// financialDashboard.exportXlsx (04-investor-portal.md 5.9 "Procedures" and
// "Export of the current view", P39; package P17).
//
// The Excel workbook of the view on the team's dashboard, from the same
// source the page shows:
// - `source: "live"`: `liveFinancialView` (the ledger now, the month in
//   progress marked), in one REPEATABLE READ transaction as `live`;
// - `source: "published"`: `companyPublishedView` (every published month);
// - `source: "published"` with `asHolder`: "Preview as", exactly what that
//   holder sees (`readHolderFinancialView`, the holder's own
//   published-through date for the fund figures too); needs `portal: read`
//   as well (FORBIDDEN otherwise) and the holder is loaded by
//   `{ id, companyId }` (another company's id is NOT_FOUND).
// The holder's own sheets (`view: "mine"`) exist only in the preview: a
// team export without `asHolder` never has a "My investment" sheet.
// No audit row (5.9: none for exports); the team's activity is not the
// investor access log.

import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ZFinancialsExportView } from "@/lib/xlsx/financials-export-input";
import { liveFinancialView } from "@/server/llc/economics/financial-dashboard";
import {
  companyPublishedView,
  readHolderFinancialView,
} from "@/server/portal/financial-view";
import { exportFinancialsXlsx } from "@/server/xlsx/financials-export";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { assertMayPreview } from "./published";

export const ZTeamExportInput = z.intersection(
  ZFinancialsExportView,
  z.object({
    source: z.enum(["live", "published"]),
    asHolder: z.string().min(1).max(64).optional(),
  }),
);

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

export const exportXlsxProcedure = withLlcAccessControl
  .meta({ policies: { "llc-financials": { allow: ["read"] } } })
  .input(ZTeamExportInput)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const company = { name: ctx.company.name };
    if (input.source === "live") {
      if (input.asHolder !== undefined || input.view === "mine") {
        badRequest("The live view has no holder figures.");
      }
      const data = await ctx.db.$transaction(
        (tx) => liveFinancialView(tx, companyId, ctx.company),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 10_000,
          timeout: 60_000,
        },
      );
      const file = await exportFinancialsXlsx(data, input, {
        companyName: company.name,
        source: "live",
      });
      return { fileName: file.fileName, base64: file.base64 };
    }
    if (input.asHolder === undefined) {
      if (input.view === "mine") {
        badRequest("Pick a holder to preview to export their own figures.");
      }
      const data = await companyPublishedView(ctx.db, companyId, ctx.company);
      const file = await exportFinancialsXlsx(data, input, {
        companyName: company.name,
        source: "published",
      });
      return { fileName: file.fileName, base64: file.base64 };
    }
    assertMayPreview(ctx.permissions);
    const holder = await ctx.db.stakeholder.findFirst({
      where: { id: input.asHolder, companyId },
      select: { id: true, companyId: true, name: true },
    });
    if (holder === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Holder not found." });
    }
    const data = await readHolderFinancialView(
      ctx.db,
      { companyId: holder.companyId, stakeholderId: holder.id },
      ctx.company,
    );
    const file = await exportFinancialsXlsx(data, input, {
      companyName: company.name,
      source: "preview",
      holderName: holder.name,
    });
    return { fileName: file.fileName, base64: file.base64 };
  });
