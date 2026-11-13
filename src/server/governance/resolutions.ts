import "server-only";
import { TRPCError } from "@trpc/server";
import type { TPrismaOrTransaction } from "@/server/db";

/**
 * For ECONOMICS procedures that store a `resolutionId` (E3, wired by G19):
 * the resolution must belong to the company. NOT_FOUND otherwise. No rule
 * about type or status.
 */
export async function assertResolutionOfCompany(
  tx: TPrismaOrTransaction,
  companyId: string,
  resolutionId: string,
): Promise<{
  id: string;
  type: string;
  status: string;
  referenceCode: string | null;
}> {
  const resolution = await tx.resolution.findFirst({
    where: { id: resolutionId, companyId },
    select: { id: true, type: true, status: true, referenceCode: true },
  });
  if (!resolution) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Resolution not found.",
    });
  }
  return resolution;
}
