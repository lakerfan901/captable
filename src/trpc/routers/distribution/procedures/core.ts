import {
  computeDistribution,
  deleteDistributionDraft,
  finalizeDistribution,
  getDistribution,
  listDistributions,
  reverseDistribution,
  saveDistributionDraft,
} from "@/server/llc/economics/distributions";
import { actorFrom } from "@/server/llc/economics/scope";
import { toWire } from "@/server/llc/economics/wire";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import {
  ZDistributionIdSchema,
  ZFinalizeSchema,
  ZReverseSchema,
  ZSaveDraftSchema,
} from "../schema";

/** The run loads the whole ledger, cash ledger, defaults and loans, and finalize writes through FOUNDATION's services (A.4 trap 7). */
const LONG_TX = { timeout: 30_000, maxWait: 10_000 } as const;

type Ctx = {
  membership: { companyId: string };
  company: { timezone: string };
};

function companyOf(ctx: Ctx) {
  return { id: ctx.membership.companyId, timezone: ctx.company.timezone };
}

export const coreProcedures = {
  list: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .query(({ ctx }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(await listDistributions(tx, companyOf(ctx))),
      ),
    ),

  get: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(ZDistributionIdSchema)
    .query(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(await getDistribution(tx, ctx.membership.companyId, input.id)),
      ),
    ),

  saveDraft: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["create"] } } })
    .input(ZSaveDraftSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await saveDistributionDraft(tx, {
            company: companyOf(ctx),
            actor: actorFrom(ctx),
            id: input.id,
            type: input.type,
            periodStart: input.periodStart ?? null,
            periodEnd: input.periodEnd,
            paymentDate: input.paymentDate,
            inputs: input.inputs,
            notes: input.notes ?? null,
          }),
        ),
      ),
    ),

  deleteDraft: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["delete"] } } })
    .input(ZDistributionIdSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await deleteDistributionDraft(tx, {
            company: companyOf(ctx),
            actor: actorFrom(ctx),
            id: input.id,
          }),
        ),
      ),
    ),

  compute: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(ZDistributionIdSchema)
    .query(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(await computeDistribution(tx, companyOf(ctx), input.id)),
        LONG_TX,
      ),
    ),

  finalize: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["update"] } } })
    .input(ZFinalizeSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(
            await finalizeDistribution(tx, {
              company: companyOf(ctx),
              actor: actorFrom(ctx),
              id: input.id,
              expectedHash: input.expectedHash,
              solvencyConfirmed: input.solvencyConfirmed,
            }),
          ),
        LONG_TX,
      ),
    ),

  reverse: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["delete"] } } })
    .input(ZReverseSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire(
            await reverseDistribution(tx, {
              company: companyOf(ctx),
              actor: actorFrom(ctx),
              id: input.id,
              reason: input.reason,
            }),
          ),
        LONG_TX,
      ),
    ),
};
