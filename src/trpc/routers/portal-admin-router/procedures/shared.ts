import "server-only";

import { TRPCError } from "@trpc/server";
import { boundRequestMeta } from "../../ballot-router/access";

// Helpers shared by the portal access admin procedures (package P3).

/** Audit context with the client-controlled IP and user agent bounded. */
export function auditContext(ctx: { requestIp: string; userAgent: string }): {
  requestIp: string;
  userAgent: string;
} {
  const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
  return { requestIp: meta.ip, userAgent: meta.userAgent };
}

/** One answer for "no such access in this company", whatever the reason. */
export function accessNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Access not found." });
}

export function memberNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
}

/** The interactive-transaction limits these procedures use. */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
