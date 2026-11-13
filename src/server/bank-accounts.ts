import "server-only";

import type { BankAccountTypeEnum } from "@/prisma/enums";
import type { PrismaTransactionalClient } from "@/server/db";
import { notFound } from "@/server/llc/economics/scope";

export type WireInstructions = {
  beneficiaryName: string;
  beneficiaryAddress: string;
  bankName: string;
  bankAddress: string;
  accountNumber: string;
  routingNumber: string;
  swiftCode: string | null;
  accountType: BankAccountTypeEnum;
};

/**
 * Full wire block of a company's bank account (for Call Notice emails).
 * Contains the unmasked account number: never log or audit the result.
 */
export async function getWireInstructions(
  tx: PrismaTransactionalClient,
  companyId: string,
  bankAccountId: string,
): Promise<WireInstructions> {
  const account = await tx.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    select: {
      beneficiaryName: true,
      beneficiaryAddress: true,
      bankName: true,
      bankAddress: true,
      accountNumber: true,
      routingNumber: true,
      swiftCode: true,
      accountType: true,
    },
  });
  if (!account) notFound("Bank account");
  return account;
}
