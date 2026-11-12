import type { TPrismaOrTransaction } from "@/server/db";

/**
 * Creates the company's PREFERRED and COMMON unit classes when missing.
 * Existing classes are never changed, so calling this twice is safe.
 */
export async function ensureDefaultUnitClasses(
  tx: TPrismaOrTransaction,
  companyId: string,
): Promise<void> {
  const existing = await tx.unitClass.findMany({
    where: { companyId },
    select: { kind: true },
  });
  const kinds = new Set(existing.map((c) => c.kind));

  if (!kinds.has("PREFERRED")) {
    await tx.unitClass.create({
      data: {
        companyId,
        kind: "PREFERRED",
        name: "Preferred Units",
        pricePerUnitCents: 100000n,
        authorizedUnits: null,
        fractionalUnitsAllowed: true,
        votesPerUnit: 1,
        prefReturnBps: 800,
        prefReturnDayCount: "ACTUAL_365",
        balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE",
        residualSplitBps: 7000,
        minCommitmentCents: 10000000n,
        minCommitmentFloorCents: 5000000n,
        offeringCapCents: 200000000n,
        initialInstallmentBps: 4000,
        acceptanceBusinessDays: 10,
        refundBusinessDays: 5,
        finalClosingDate: null,
        balanceOutsideDate: null,
      },
    });
  }

  if (!kinds.has("COMMON")) {
    await tx.unitClass.create({
      data: {
        companyId,
        kind: "COMMON",
        name: "Common Units",
        pricePerUnitCents: null,
        authorizedUnits: 100,
        fractionalUnitsAllowed: false,
        votesPerUnit: 0,
        prefReturnBps: 0,
        residualSplitBps: 3000,
        minCommitmentCents: null,
        minCommitmentFloorCents: null,
        offeringCapCents: null,
        initialInstallmentBps: 4000,
        finalClosingDate: null,
        balanceOutsideDate: null,
      },
    });
  }
}
