import { Audit } from "@/server/audit";
import {
  conflict,
  notFound,
  ruleViolation,
} from "@/server/llc/economics/scope";
import { createTRPCRouter, withAccessControl } from "@/trpc/api/trpc";
import {
  accountLast4,
  nextPrimaryFlag,
  ZodCreateBankAccountSchema,
  ZodDeleteBankAccountSchema,
} from "./schema";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export const bankAccountsRouter = createTRPCRouter({
  getAll: withAccessControl
    .meta({ policies: { "bank-accounts": { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const {
        db,
        membership: { companyId },
      } = ctx;

      const bankAccounts = await db.bankAccount.findMany({
        where: {
          companyId,
        },

        orderBy: {
          createdAt: "desc",
        },

        select: {
          id: true,
          bankName: true,
          accountNumber: true,
          primary: true,
          createdAt: true,
          beneficiaryName: true,
          beneficiaryAddress: true,
          bankAddress: true,
          routingNumber: true,
          accountType: true,
          swiftCode: true,
        },
      });

      return {
        bankAccounts,
      };
    }),

  create: withAccessControl
    .meta({ policies: { "bank-accounts": { allow: ["create"] } } })
    .input(ZodCreateBankAccountSchema)
    .mutation(async ({ ctx, input }) => {
      const {
        db,
        membership: { companyId },
      } = ctx;

      try {
        return await db.$transaction(async (tx) => {
          const existing = await tx.bankAccount.findMany({
            where: { companyId },
            select: { primary: true, accountNumber: true },
          });

          if (existing.some((a) => a.accountNumber === input.accountNumber)) {
            conflict("A bank account with this account number already exists.");
          }

          const primary = nextPrimaryFlag(existing);
          if (primary === null) {
            ruleViolation("At most two bank accounts are supported.");
          }

          const account = await tx.bankAccount.create({
            data: {
              companyId,
              beneficiaryName: input.beneficiaryName,
              beneficiaryAddress: input.beneficiaryAddress,
              bankName: input.bankName,
              bankAddress: input.bankAddress,
              accountNumber: input.accountNumber,
              routingNumber: input.routingNumber,
              accountType: input.accountType,
              swiftCode: input.swiftCode ?? null,
              primary,
            },
            select: { id: true, primary: true },
          });

          await Audit.create(
            {
              action: "bankAccount.created",
              companyId,
              actor: { type: "user", id: ctx.session.user.id },
              context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
              target: [{ type: "bankAccount", id: account.id }],
              summary: `${ctx.session.user.name ?? "A team member"} added the bank account ${input.bankName} ending ${accountLast4(input.accountNumber)}${account.primary ? " (primary)" : ""}.`,
            },
            tx,
          );

          return { id: account.id, primary: account.primary };
        });
      } catch (error) {
        // A concurrent create can still hit either unique index.
        if (isUniqueViolation(error)) {
          conflict(
            "The bank accounts changed while saving; reload and try again.",
          );
        }
        throw error;
      }
    }),

  delete: withAccessControl
    .meta({ policies: { "bank-accounts": { allow: ["delete"] } } })
    .input(ZodDeleteBankAccountSchema)
    .mutation(async ({ ctx, input }) => {
      const {
        db,
        membership: { companyId },
      } = ctx;

      await db.$transaction(async (tx) => {
        const account = await tx.bankAccount.findFirst({
          where: { id: input.id, companyId },
          select: { id: true, bankName: true, accountNumber: true },
        });
        if (!account) notFound("Bank account");

        const inUse = await tx.callNotice.count({
          where: {
            companyId,
            bankAccountId: account.id,
            status: { in: ["DRAFT", "SENT"] },
          },
        });
        if (inUse > 0) {
          ruleViolation(
            "This bank account is printed on a draft or sent Call Notice and cannot be deleted.",
          );
        }

        await tx.bankAccount.delete({ where: { id: account.id } });

        await Audit.create(
          {
            action: "bankAccount.deleted",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
            target: [{ type: "bankAccount", id: account.id }],
            summary: `${ctx.session.user.name ?? "A team member"} deleted the bank account ${account.bankName} ending ${accountLast4(account.accountNumber)}.`,
          },
          tx,
        );
      });

      return { success: true };
    }),
});
