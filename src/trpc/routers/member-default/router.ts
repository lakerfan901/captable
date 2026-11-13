import { microUnitsFromDecimal } from "@/lib/llc/money";
import { numberToCents } from "@/lib/money";
import { economicsToday } from "@/server/llc/economics/clock";
import {
  addDefaultCharge,
  confirmCredit,
  confirmCure,
  confirmForfeiture,
  declareDefault,
  getDefaultView,
  getOverdueUndeclared,
  listDefaults,
  previewDefaultPayment,
  reconcileBeforeDeclare,
  recordDefaultFunding,
  recordDefaultPayment,
  voidDefault,
} from "@/server/llc/economics/defaults";
import { actorFrom } from "@/server/llc/economics/scope";
import { toWire } from "@/server/llc/economics/wire";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  ZAddChargeSchema,
  ZConfirmCreditSchema,
  ZConfirmCureSchema,
  ZConfirmForfeitureSchema,
  ZDeclareSchema,
  ZMemberDefaultIdSchema,
  ZPreviewDefaultPaymentSchema,
  ZRecordDefaultPaymentSchema,
  ZRecordFundingSchema,
  ZVoidSchema,
} from "./schema";

/** Steps that call several FOUNDATION services and the ledger engine. */
const LONG_TX = { timeout: 30_000, maxWait: 10_000 } as const;

export const memberDefaultRouter = createTRPCRouter({
  previewPayment: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .input(ZPreviewDefaultPaymentSchema)
    .query(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await previewDefaultPayment(tx, ctx.membership.companyId, {
            id: input.id,
            paidOn: input.paidOn,
            amountCents: numberToCents(input.amountCents),
          }),
        ),
      ),
    ),

  overdue: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .query(({ ctx }) => {
      const today = economicsToday(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) =>
        toWire({
          today,
          lines: await getOverdueUndeclared(
            tx,
            ctx.membership.companyId,
            today,
          ),
        }),
      );
    }),

  list: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .query(({ ctx }) => {
      const today = economicsToday(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) =>
        toWire({
          today,
          defaults: await listDefaults(tx, ctx.membership.companyId, today),
        }),
      );
    }),

  get: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .input(ZMemberDefaultIdSchema)
    .query(({ ctx, input }) => {
      const today = economicsToday(ctx.company.timezone);
      return ctx.db.$transaction(
        async (tx) =>
          toWire({
            today,
            view: await getDefaultView(
              tx,
              ctx.membership.companyId,
              input.id,
              today,
            ),
          }),
        LONG_TX,
      );
    }),

  declare: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZDeclareSchema)
    .mutation(async ({ ctx, input }) => {
      // Money already received is applied in its own transaction first, so
      // the match stays even when the declaration below is refused (B2).
      await ctx.db.$transaction(
        (tx) =>
          reconcileBeforeDeclare(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
            callNoticeLineId: input.callNoticeLineId,
          }),
        LONG_TX,
      );
      return ctx.db.$transaction(
        async (tx) =>
          toWire(
            await declareDefault(tx, {
              company: ctx.company,
              actor: actorFrom(ctx),
              callNoticeLineId: input.callNoticeLineId,
              expectedUnpaidCents: numberToCents(input.expectedUnpaidCents),
            }),
          ),
        LONG_TX,
      );
    }),

  void: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["delete"] } } })
    .input(ZVoidSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await voidDefault(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
            id: input.id,
            reason: input.reason,
          }),
        ),
      ),
    ),

  addCharge: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZAddChargeSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await addDefaultCharge(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
            id: input.id,
            incurredOn: input.incurredOn,
            amountCents: numberToCents(input.amountCents),
            description: input.description,
            documentId: input.documentId,
          }),
        ),
      ),
    ),

  recordFunding: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZRecordFundingSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(
            await recordDefaultFunding(tx, {
              company: ctx.company,
              actor: actorFrom(ctx),
              id: input.id,
              funderStakeholderId: input.funderStakeholderId,
              amountCents: numberToCents(input.amountCents),
              fundedOn: input.fundedOn,
              reference: input.reference || undefined,
            }),
          ),
        LONG_TX,
      ),
    ),

  recordPayment: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZRecordDefaultPaymentSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(
            await recordDefaultPayment(tx, {
              company: ctx.company,
              actor: actorFrom(ctx),
              id: input.id,
              paidOn: input.paidOn,
              amountCents: numberToCents(input.amountCents),
              expected: {
                toBalanceCents: numberToCents(input.expected.toBalanceCents),
                toInterestCents: numberToCents(input.expected.toInterestCents),
                toCostsCents: numberToCents(input.expected.toCostsCents),
              },
            }),
          ),
        LONG_TX,
      ),
    ),

  confirmForfeiture: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["update"] } } })
    .input(ZConfirmForfeitureSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(
            await confirmForfeiture(tx, {
              company: ctx.company,
              actor: actorFrom(ctx),
              id: input.id,
              expectedForfeitedCents: numberToCents(
                input.expectedForfeitedCents,
              ),
              expectedUnitsAfter: microUnitsFromDecimal(
                input.expectedUnitsAfter,
              ),
            }),
          ),
        LONG_TX,
      ),
    ),

  confirmCredit: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["update"] } } })
    .input(ZConfirmCreditSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(
            await confirmCredit(tx, {
              company: ctx.company,
              actor: actorFrom(ctx),
              id: input.id,
              expectedPoolACents: numberToCents(input.expectedPoolACents),
              expectedPoolBCents: numberToCents(input.expectedPoolBCents),
              expectedCreditDate: input.expectedCreditDate,
            }),
          ),
        LONG_TX,
      ),
    ),

  confirmCure: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["update"] } } })
    .input(ZConfirmCureSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await confirmCure(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
            id: input.id,
            expectedCuredOn: input.expectedCuredOn,
          }),
        ),
      ),
    ),
});
