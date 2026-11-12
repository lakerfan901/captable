import "server-only";

import { TRPCError } from "@trpc/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withServerComponentSession } from "@/server/auth";
import { db, type TPrismaOrTransaction } from "@/server/db";

export const getSessionEntity = cache(async () => {
  const session = await withServerComponentSession();
  const company = await db.company.findUniqueOrThrow({
    where: { id: session.user.companyId },
    select: {
      id: true,
      publicId: true,
      name: true,
      entityType: true,
      timezone: true,
    },
  });
  return { ...company, isLlc: company.entityType === "LLC" };
});

export type SessionEntity = Awaited<ReturnType<typeof getSessionEntity>>;

/** Returns the session entity, or redirects to the overview when not LLC. */
export async function requireLlc(): Promise<SessionEntity> {
  const entity = await getSessionEntity();
  if (!entity.isLlc) redirect(`/${entity.publicId}`);
  return entity;
}

/** Returns the session entity, or redirects to the overview when LLC. */
export async function requireCorporation(): Promise<SessionEntity> {
  const entity = await getSessionEntity();
  if (entity.isLlc) redirect(`/${entity.publicId}`);
  return entity;
}

/** For jobs and public procedures without `withLlcAccessControl`. */
export async function assertLlcCompany(
  tx: TPrismaOrTransaction,
  companyId: string,
): Promise<void> {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { entityType: true },
  });
  if (company?.entityType !== "LLC") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This feature is available for LLC companies only.",
    });
  }
}
