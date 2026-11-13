import "server-only";

import { TRPCError } from "@trpc/server";
import type { PrismaTransactionalClient } from "@/server/db";
import type { LedgerActor } from "@/server/llc/commitments";

/**
 * Serialises every economics ledger write of one company for the rest of the
 * transaction (Postgres transaction-scoped advisory lock). Verified against
 * Postgres through the pg driver adapter (defaults.integration.ts, "ledger
 * lock"): a second transaction blocks here until the first commits, and a
 * different company does not block.
 */
export async function lockCompanyLedger(
  tx: PrismaTransactionalClient,
  companyId: string,
): Promise<void> {
  const key = `llc-economics:${companyId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * `lockCompanyLedger`, then the row lock FOUNDATION's services take on each
 * unit class (`lockUnitClass` in commitments.ts: SELECT … FOR UPDATE),
 * Preferred before Common. FOUNDATION's own writes (Commitments page
 * receipts, voids, Common issuance) take only the class lock, so an
 * economics step that reads positions must hold the class locks before it
 * reads, or such a write can commit unseen in between. Order: advisory lock
 * first, class locks second, as everywhere in economics.
 */
export async function lockCompanyLedgerAndUnitClasses(
  tx: PrismaTransactionalClient,
  companyId: string,
): Promise<void> {
  await lockCompanyLedger(tx, companyId);
  const classes = await tx.unitClass.findMany({
    where: { companyId },
    select: { id: true, kind: true },
    orderBy: { id: "asc" },
  });
  const ordered = [
    ...classes.filter((c) => c.kind === "PREFERRED"),
    ...classes.filter((c) => c.kind !== "PREFERRED"),
  ];
  for (const c of ordered) {
    await tx.$queryRaw`
      SELECT id FROM "UnitClass"
      WHERE id = ${c.id} AND "companyId" = ${companyId}
      FOR UPDATE`;
  }
}

/** TRPCError NOT_FOUND: "<what> not found." */
export function notFound(what: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found.` });
}

/** TRPCError CONFLICT: a confirmed proposal no longer matches. */
export function conflict(message: string): never {
  throw new TRPCError({ code: "CONFLICT", message });
}

/** TRPCError BAD_REQUEST: the message names the OA section where one applies. */
export function ruleViolation(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

type ActorContext = {
  session: { user: { id: string; name?: string | null } };
  membership: { memberId: string | null };
  requestIp: string;
  userAgent: string;
};

/** The `actor` FOUNDATION's F6 services take. */
export function actorFrom(ctx: ActorContext): LedgerActor {
  return {
    userId: ctx.session.user.id,
    memberId: ctx.membership.memberId,
    name: ctx.session.user.name ?? "A team member",
    requestIp: ctx.requestIp,
    userAgent: ctx.userAgent,
  };
}
