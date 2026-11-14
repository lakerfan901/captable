import { z } from "zod";
import {
  exportDistributionCsv,
  markDistributionLinesPaid,
  resendDistributionNotices,
  sendDistributionNotices,
} from "@/server/llc/economics/distribution-export";
import { actorFrom } from "@/server/llc/economics/scope";
import { toWire } from "@/server/llc/economics/wire";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { zId, zIsoDate } from "@/trpc/routers/llc-shared/schema";
import { ZDistributionIdSchema } from "../schema";

// Inputs live here because E17 may modify only this router file.
export const ZSendNoticesSchema = z.object({
  id: zId,
  lineIds: z.array(zId).max(500).optional(),
});

export const ZResendNoticesSchema = z.object({
  id: zId,
  /** Each line with the notice count the page showed (idempotency: a double click sends once). */
  lines: z
    .array(
      z.object({ lineId: zId, sendCount: z.number().int().min(0).max(10_000) }),
    )
    .min(1)
    .max(500)
    .refine((l) => new Set(l.map((x) => x.lineId)).size === l.length, {
      message: "A line is listed twice.",
    }),
});

export const ZMarkPaidSchema = z.object({
  id: zId,
  lineIds: z.array(zId).min(1).max(500),
  paidOn: zIsoDate,
  paymentReference: z.string().trim().max(100).optional(),
});

type ManagerCtx = {
  session: { user: { name?: string | null; email?: string | null } };
};

/** The person named in "Questions: {managerName}, {managerEmail}." (the sending team member), as Call Notices. */
function managerFrom(ctx: ManagerCtx) {
  return {
    name: ctx.session.user.name ?? "The Manager",
    email: ctx.session.user.email ?? "",
  };
}

export const deliveryProcedures = {
  /** Not one transaction: each line is claimed by a guarded write before its email is sent (see distribution-export.ts). */
  sendNotices: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["update"] } } })
    .input(ZSendNoticesSchema)
    .mutation(async ({ ctx, input }) =>
      toWire(
        await sendDistributionNotices(ctx.db, {
          company: { id: ctx.membership.companyId, name: ctx.company.name },
          actor: actorFrom(ctx),
          manager: managerFrom(ctx),
          id: input.id,
          lineIds: input.lineIds,
        }),
      ),
    ),

  /**
   * Re-sends sent notices (bounced or corrected address) to each member's
   * current notice address; figures are the stored line's, nothing economic
   * changes. Not one transaction, as sendNotices (see distribution-export.ts).
   */
  resendNotices: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["update"] } } })
    .input(ZResendNoticesSchema)
    .mutation(async ({ ctx, input }) =>
      toWire(
        await resendDistributionNotices(ctx.db, {
          company: { id: ctx.membership.companyId, name: ctx.company.name },
          actor: actorFrom(ctx),
          manager: managerFrom(ctx),
          id: input.id,
          lines: input.lines,
        }),
      ),
    ),

  exportCsv: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(ZDistributionIdSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        exportDistributionCsv(tx, {
          company: { id: ctx.membership.companyId, name: ctx.company.name },
          actor: actorFrom(ctx),
          id: input.id,
        }),
      ),
    ),

  markPaid: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["update"] } } })
    .input(ZMarkPaidSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        markDistributionLinesPaid(tx, {
          company: { id: ctx.membership.companyId },
          actor: actorFrom(ctx),
          id: input.id,
          lineIds: input.lineIds,
          paidOn: input.paidOn,
          paymentReference: input.paymentReference || null,
        }),
      ),
    ),
};
