import { numberToCents } from "@/lib/money";
import {
  cancelCallNoticeDraft,
  createOutsideDateNotice,
  getCallNotice,
  getEligible,
  getOverdueLines,
  listCallNotices,
  previewCallNotice,
  reconcileCallNoticeLines,
  recordCallNoticePayment,
  resolveCallNoticeSending,
  saveCallNoticeDraft,
  sendCallNotice,
} from "@/server/llc/economics/call-notices";
import { economicsToday } from "@/server/llc/economics/clock";
import { actorFrom } from "@/server/llc/economics/scope";
import { toWire } from "@/server/llc/economics/wire";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  ZCallNoticeIdSchema,
  ZCancelDraftSchema,
  ZCreateOutsideDateNoticeSchema,
  ZPreviewSchema,
  ZReconcileSchema,
  ZRecordPaymentSchema,
  ZResolveSendingSchema,
  ZSaveDraftSchema,
  ZSendSchema,
} from "./schema";

type ManagerCtx = {
  session: { user: { name?: string | null; email?: string | null } };
};

/** The person named in "Questions: {managerName}, {managerEmail}." (the sending team member). */
function managerFrom(ctx: ManagerCtx) {
  return {
    name: ctx.session.user.name ?? "The Manager",
    email: ctx.session.user.email ?? "",
  };
}

export const callNoticeRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const today = economicsToday(ctx.company.timezone);
      return toWire({
        today,
        notices: await listCallNotices(ctx.db, ctx.membership.companyId, today),
      });
    }),

  get: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .input(ZCallNoticeIdSchema)
    .query(({ ctx, input }) => {
      const today = economicsToday(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) =>
        toWire({
          today,
          ...(await getCallNotice(
            tx,
            ctx.membership.companyId,
            today,
            input.id,
          )),
        }),
      );
    }),

  eligible: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .query(({ ctx }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(await getEligible(tx, ctx.company)),
      ),
    ),

  saveDraft: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZSaveDraftSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await saveCallNoticeDraft(tx, {
            companyId: ctx.membership.companyId,
            actor: actorFrom(ctx),
            id: input.id,
            purpose: input.purpose,
            bankAccountId: input.bankAccountId,
            lines: input.lines.map((l) => ({
              commitmentId: l.commitmentId,
              amountCalledCents: numberToCents(l.amountCalledCents),
            })),
          }),
        ),
      ),
    ),

  cancelDraft: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["delete"] } } })
    .input(ZCancelDraftSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.$transaction((tx) =>
        cancelCallNoticeDraft(tx, {
          companyId: ctx.membership.companyId,
          actor: actorFrom(ctx),
          id: input.id,
          reason: input.reason,
        }),
      );
      return { ok: true };
    }),

  preview: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .input(ZPreviewSchema)
    .query(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        previewCallNotice(tx, {
          company: ctx.company,
          id: input.id,
          commitmentId: input.commitmentId,
          manager: managerFrom(ctx),
        }),
      ),
    ),

  send: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZSendSchema)
    .mutation(async ({ ctx, input }) =>
      toWire(
        await sendCallNotice(ctx.db, {
          company: ctx.company,
          actor: actorFrom(ctx),
          manager: managerFrom(ctx),
          id: input.id,
          expectedDueOn: input.expectedDueOn,
          lineIds: input.lineIds,
        }),
      ),
    ),

  createOutsideDateNotice: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZCreateOutsideDateNoticeSchema)
    .mutation(({ ctx }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await createOutsideDateNotice(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
          }),
        ),
      ),
    ),

  recordPayment: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["create"] } } })
    .input(ZRecordPaymentSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await recordCallNoticePayment(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
            commitmentId: input.commitmentId,
            receivedOn: input.receivedOn,
            amountCents: numberToCents(input.amountCents),
            reference: input.reference || undefined,
            note: input.note || undefined,
          }),
        ),
      ),
    ),

  /** "Re-match prepaid money": matches prepaid Balance money to sent lines not yet matched. */
  reconcile: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["update"] } } })
    .input(ZReconcileSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(
        async (tx) =>
          toWire({
            lines: await reconcileCallNoticeLines(
              tx,
              ctx.membership.companyId,
              input.commitmentId,
              actorFrom(ctx),
            ),
          }),
        { maxWait: 10_000, timeout: 30_000 },
      ),
    ),

  /** Resolves a line left in SENDING (Resolve / Mark as sent / Mark as not sent). */
  resolveSending: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["update"] } } })
    .input(ZResolveSendingSchema)
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        toWire(
          await resolveCallNoticeSending(tx, {
            company: ctx.company,
            actor: actorFrom(ctx),
            lineId: input.lineId,
            action: input.action,
            sentOn: input.sentOn,
          }),
        ),
      ),
    ),

  overdue: withLlcAccessControl
    .meta({ policies: { "capital-calls": { allow: ["read"] } } })
    .query(({ ctx }) =>
      ctx.db.$transaction(async (tx) =>
        toWire({ lines: await getOverdueLines(tx, ctx.company) }),
      ),
    ),
});
