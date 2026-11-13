import "server-only";
import { TRPCError } from "@trpc/server";
import type { PrismaTransactionalClient } from "@/server/db";
import { boundRequestMeta } from "../../ballot-router/access";

// Helpers shared by the compliance procedures (03-governance.md G14).
//
// Concurrency rule of this router: a row is read by `{ id, companyId }`
// (NOT_FOUND otherwise), then changed by ONE single-row guarded `update`
// whose `where` repeats the status it requires (server/governance/guarded.ts);
// a lost race is reported as BAD_REQUEST, never as a silent overwrite.

/** Interactive transaction options: the sync reads the whole ledger. */
export const COMPLIANCE_TX = { timeout: 30_000, maxWait: 10_000 } as const;

/** Audit context with the client-controlled IP and user agent bounded. */
export function auditContext(ctx: { requestIp: string; userAgent: string }): {
  requestIp: string;
  userAgent: string;
} {
  const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
  return { requestIp: meta.ip, userAgent: meta.userAgent };
}

export function deadlineNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Deadline not found." });
}

/** A linked resolution, report or document that is missing or of another company. */
export function linkedNotFound(what: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found.` });
}

export function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

export const ONLY_OPEN = "Only an open deadline can be changed.";

/** The deadline of the company; NOT_FOUND otherwise. */
export async function loadDeadline(
  tx: PrismaTransactionalClient,
  companyId: string,
  id: string,
) {
  const row = await tx.complianceDeadline.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      ruleKey: true,
      title: true,
      status: true,
      dueOn: true,
      source: true,
    },
  });
  if (!row) deadlineNotFound();
  return row;
}

export function userName(ctx: { session: { user: { name?: string | null } } }) {
  return ctx.session.user.name ?? "A user";
}
