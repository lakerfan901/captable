import "server-only";

import { TRPCError } from "@trpc/server";
import type { PrismaTransactionalClient } from "@/server/db";
import type { LedgerActor } from "@/server/llc/commitments";

/**
 * Serialises every economics ledger write of one company for the rest of the
 * transaction (Postgres transaction-scoped advisory lock).
 * NOT YET VERIFIED against a database: `$executeRaw` returns the row count and
 * does not read the `void` column. If the pg driver adapter rejects it, switch
 * to `$queryRaw\`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked\``.
 */
export async function lockCompanyLedger(
  tx: PrismaTransactionalClient,
  companyId: string,
): Promise<void> {
  const key = `llc-economics:${companyId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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
