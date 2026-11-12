import { TRPCError } from "@trpc/server";
import { env } from "@/env";
import { Audit } from "@/server/audit";
import { isMailCatcherConfigured, sendMail } from "@/server/mailer";
import { createTRPCRouter, withAccessControl } from "@/trpc/api/trpc";
import {
  type EmailLogDTO,
  ZodListEmailLogSchema,
  ZodMarkBounceSchema,
  ZodSendTestEmailSchema,
} from "./schema";

// Never select bodySha256/smtpResponse/fromAddress: the DTO is all the UI needs.
const emailLogSelect = {
  id: true,
  toAddress: true,
  subject: true,
  kind: true,
  status: true,
  sentAt: true,
  createdAt: true,
  providerMessageId: true,
  errorMessage: true,
  bounceState: true,
  bouncedAt: true,
  bounceNote: true,
  stakeholderId: true,
  relatedType: true,
  relatedId: true,
  stakeholder: { select: { name: true } },
} as const;

type EmailLogRow = {
  id: string;
  toAddress: string;
  subject: string;
  kind: string;
  status: EmailLogDTO["status"];
  sentAt: Date | null;
  createdAt: Date;
  providerMessageId: string | null;
  errorMessage: string | null;
  bounceState: EmailLogDTO["bounceState"];
  bouncedAt: Date | null;
  bounceNote: string | null;
  stakeholderId: string | null;
  relatedType: string | null;
  relatedId: string | null;
  stakeholder: { name: string } | null;
};

const toDTO = (row: EmailLogRow): EmailLogDTO => ({
  id: row.id,
  toAddress: row.toAddress,
  subject: row.subject,
  kind: row.kind,
  status: row.status,
  sentAt: row.sentAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  providerMessageId: row.providerMessageId,
  errorMessage: row.errorMessage,
  bounceState: row.bounceState,
  bouncedAt: row.bouncedAt?.toISOString() ?? null,
  bounceNote: row.bounceNote,
  stakeholderId: row.stakeholderId,
  stakeholderName: row.stakeholder?.name ?? null,
  relatedType: row.relatedType,
  relatedId: row.relatedId,
});

const BOUNCE_WORDS = {
  NONE: "not bounced",
  BOUNCED: "bounced",
  COMPLAINED: "complained (spam report)",
} as const;

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const emailLogRouter = createTRPCRouter({
  list: withAccessControl
    .meta({ policies: { emails: { allow: ["read"] } } })
    .input(ZodListEmailLogSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;

      if (input.cursor) {
        const cursorRow = await ctx.db.emailLog.findFirst({
          where: { id: input.cursor, companyId },
          select: { id: true },
        });
        if (!cursorRow) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Email log entry not found.",
          });
        }
      }

      const rows = await ctx.db.emailLog.findMany({
        where: {
          companyId,
          ...(input.stakeholderId
            ? { stakeholderId: input.stakeholderId }
            : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: emailLogSelect,
      });

      const hasMore = rows.length > input.take;
      const page = hasMore ? rows.slice(0, input.take) : rows;
      return {
        items: page.map(toDTO),
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      };
    }),

  markBounce: withAccessControl
    .meta({ policies: { emails: { allow: ["update"] } } })
    .input(ZodMarkBounceSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const note = input.note ? input.note : null;

      return ctx.db.$transaction(async (tx) => {
        const existing = await tx.emailLog.findFirst({
          where: { id: input.id, companyId },
          select: { id: true, subject: true, toAddress: true },
        });
        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Email log entry not found.",
          });
        }

        const updated = await tx.emailLog.update({
          where: { id: existing.id, companyId },
          data: {
            bounceState: input.bounceState,
            bouncedAt: input.bounceState === "NONE" ? null : new Date(),
            bounceNote: note,
          },
          select: emailLogSelect,
        });

        await Audit.create(
          {
            action: "emailLog.bounce-marked",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: {
              userAgent: ctx.userAgent,
              requestIp: ctx.requestIp,
            },
            target: [{ type: "emailLog", id: existing.id }],
            summary: `${ctx.session.user.name} marked the email "${existing.subject}" to ${existing.toAddress} as ${BOUNCE_WORDS[input.bounceState]}${note ? `: ${note}` : ""}`,
          },
          tx,
        );

        return toDTO(updated);
      });
    }),

  deliveryStatus: withAccessControl
    .meta({ policies: { emails: { allow: ["read"] } } })
    .query(() => ({
      mailCatcher: isMailCatcherConfigured(),
      fromAddress: env.EMAIL_FROM,
    })),

  sendTest: withAccessControl
    .meta({ policies: { emails: { allow: ["create"] } } })
    .input(ZodSendTestEmailSchema)
    .mutation(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const company = await ctx.db.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      });
      const companyName = company?.name ?? "Captable";

      try {
        await sendMail(
          {
            to: input.to,
            subject: `Test email from ${companyName}`,
            html: `<p>This is a test email from ${escapeHtml(companyName)}.</p><p>If you received it, email delivery works.</p>`,
            headers: { "X-From-Name": companyName },
          },
          { kind: "test", companyId },
        );
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "The SMTP server did not accept the email.";
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }

      return { ok: true as const };
    }),
});
