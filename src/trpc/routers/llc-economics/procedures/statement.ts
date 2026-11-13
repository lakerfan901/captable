// Member statement and fair value procedures (E18).
import { z } from "zod";
import { microUnitsFromDecimal } from "@/lib/llc/money";
import {
  getFairValue,
  getFairValuePrefill,
  getMemberStatement,
} from "@/server/llc/economics/statements";
import { toWire } from "@/server/llc/economics/wire";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import {
  zCents,
  zId,
  zIsoDate,
  zUnits,
} from "@/trpc/routers/llc-shared/schema";

const ZMemberStatementInput = z
  .object({ stakeholderId: zId, from: zIsoDate, to: zIsoDate })
  .refine((v) => v.from <= v.to, {
    message: "The start date must not be after the end date.",
    path: ["to"],
  });

const ZFairValueInput = z.object({
  asOf: zIsoDate,
  assetFmvCents: zCents,
  cashOnHandCents: zCents,
  liabilitiesCents: zCents,
  includeMemberLoans: z.boolean(),
  stakeholderId: zId.optional(),
  unitClass: z.enum(["PREFERRED", "COMMON"]).optional(),
  unitsValued: zUnits.optional(),
});

export const statementProcedures = {
  memberStatement: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(ZMemberStatementInput)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      await assertCompanyOwns(ctx.db, companyId, {
        stakeholderIds: [input.stakeholderId],
      });
      return toWire(
        await getMemberStatement(ctx.db, companyId, input.stakeholderId, {
          from: input.from,
          to: input.to,
        }),
      );
    }),

  fairValue: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(ZFairValueInput)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      if (input.stakeholderId) {
        await assertCompanyOwns(ctx.db, companyId, {
          stakeholderIds: [input.stakeholderId],
        });
      }
      return toWire(
        await getFairValue(ctx.db, companyId, {
          asOf: input.asOf,
          assetFmv: BigInt(input.assetFmvCents),
          cashOnHand: BigInt(input.cashOnHandCents),
          liabilities: BigInt(input.liabilitiesCents),
          includeMemberLoans: input.includeMemberLoans,
          selection: input.stakeholderId
            ? {
                stakeholderId: input.stakeholderId,
                unitClass: input.unitClass,
                unitsValued:
                  input.unitsValued === undefined
                    ? undefined
                    : microUnitsFromDecimal(input.unitsValued),
              }
            : null,
        }),
      );
    }),

  /** Prefill figures for the selected valuation date (Codex review 2, finding 4). */
  fairValuePrefill: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(z.object({ asOf: zIsoDate }))
    .query(async ({ ctx, input }) =>
      toWire(
        await getFairValuePrefill(ctx.db, ctx.membership.companyId, input.asOf),
      ),
    ),
};
