import "server-only";
import { TRPCError } from "@trpc/server";
import type { TPrismaOrTransaction } from "@/server/db";

/**
 * For jobs and public token procedures (no session). Manager procedures use
 * FOUNDATION's `withLlcAccessControl` instead. Throws NOT_FOUND for a company
 * that is not an LLC, so a token reveals nothing.
 */
export async function loadLlcCompany(
  tx: TPrismaOrTransaction,
  companyId: string,
) {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      publicId: true,
      name: true,
      logo: true,
      entityType: true,
      timezone: true,
    },
  });
  if (company?.entityType !== "LLC") {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return company;
}
