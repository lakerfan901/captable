import "server-only";

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { env } from "@/env";
import { sameOrigin, shouldTouch } from "@/lib/portal/session-core";
import type { LlcMemberStatusEnum } from "@/prisma/enums";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadLlcCompany } from "@/server/governance/guards";
import { guardedUpdate } from "@/server/guarded-write";
import { loadPortalSession } from "@/server/portal/session";
import { withoutAuth } from "@/trpc/api/trpc";

// The investor procedure base (04-investor-portal.md 5.3; package P2a).
//
// Built on `withoutAuth`; `src/trpc/api/trpc.ts` is not changed. Only
// `src/trpc/routers/portal-router/**` and `portal-auth-router/**` may import
// this file (G5).
//
// G1. Authentication comes only from the portal cookie. `createTRPCContext`
//     still resolves the next-auth session for every request; middleware A
//     replaces `ctx.session` with `null` before any portal code runs, so a
//     team session in the same browser is never read here.
// G2. `companyId` and `stakeholderId` come only from `ctx.holder`, which is
//     resolved from a `PortalAccess` row that belongs to the signed-in
//     portal user. No portal input carries either id.
// G6. A portal session grants nothing to the team procedures, server actions
//     or `(authenticated)` pages: they read only the next-auth session.

/** The signed-in portal user, as middleware A puts it on the context. */
export interface PortalUserContext {
  id: string;
  email: string;
  name: string | null;
}

/** The holder resolved from the access named in the input (middleware B). */
export interface InvestorHolder {
  /** `PortalAccess.id` (server only). */
  accessId: string;
  /** `PortalAccess.publicId`, the only access identifier a browser sees. */
  accessPublicId: string;
  stakeholderId: string;
  companyId: string;
  name: string;
  memberStatus: LlcMemberStatusEnum;
}

export type InvestorCompany = Awaited<ReturnType<typeof loadLlcCompany>>;

/**
 * Middleware A: a mutation from a browser must carry the app's own Origin
 * (S17; the RSC caller, which sends no Origin, marks itself with
 * `x-trpc-source: rsc`, a header a cross-site request cannot set without a
 * CORS preflight this app never grants). Then the portal session from the
 * cookie, or UNAUTHORIZED. The team session is overwritten with null.
 */
export const portalSessionProcedure = withoutAuth.use(
  async ({ ctx, type, next }) => {
    if (
      type === "mutation" &&
      ctx.headers.get("x-trpc-source") !== "rsc" &&
      !sameOrigin(ctx.headers.get("origin"), env.NEXT_PUBLIC_BASE_URL)
    ) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const found = await loadPortalSession(
      ctx.db,
      ctx.headers.get("cookie"),
      new Date(),
    );
    if (found === null) throw new TRPCError({ code: "UNAUTHORIZED" });
    const portalUser: PortalUserContext = found.portalUser;
    return next({
      ctx: {
        db: ctx.db,
        headers: ctx.headers,
        requestIp: ctx.requestIp,
        userAgent: ctx.userAgent,
        session: null,
        portalUser,
        portalSessionId: found.sessionId,
      },
    });
  },
);

/**
 * Resolves one holder for a signed-in portal user (5.3 middleware B, P10):
 * the access by `{ publicId, portalUserId, status: ACTIVE }`, the holder by
 * `{ id, companyId }` of that access, and the company, which must be an LLC.
 * Every miss is the same message-less NOT_FOUND. `PortalAccess.lastSeenAt`
 * is refreshed at most every 5 minutes.
 */
export async function resolveHolder(
  db: TPrismaOrTransaction,
  portalUserId: string,
  accessPublicId: string,
  now: Date = new Date(),
): Promise<{ holder: InvestorHolder; company: InvestorCompany }> {
  const notFound = () => new TRPCError({ code: "NOT_FOUND" });
  const access = await db.portalAccess.findFirst({
    where: { publicId: accessPublicId, portalUserId, status: "ACTIVE" },
    select: {
      id: true,
      publicId: true,
      companyId: true,
      stakeholderId: true,
      lastSeenAt: true,
    },
  });
  if (access === null) throw notFound();
  const stakeholder = await db.stakeholder.findFirst({
    where: { id: access.stakeholderId, companyId: access.companyId },
    select: { id: true, companyId: true, name: true, memberStatus: true },
  });
  if (stakeholder === null) throw notFound();
  let company: InvestorCompany;
  try {
    company = await loadLlcCompany(db, access.companyId);
  } catch (error) {
    if (error instanceof TRPCError) throw notFound();
    throw error;
  }
  if (access.lastSeenAt === null || shouldTouch(access.lastSeenAt, now)) {
    await guardedUpdate(() =>
      db.portalAccess.update({
        where: { id: access.id, status: "ACTIVE" },
        data: { lastSeenAt: now },
        select: { id: true },
      }),
    );
  }
  return {
    holder: {
      accessId: access.id,
      accessPublicId: access.publicId,
      stakeholderId: stakeholder.id,
      companyId: stakeholder.companyId,
      name: stakeholder.name,
      memberStatus: stakeholder.memberStatus,
    },
    company,
  };
}

/**
 * For server pages (P8): the portal session from the cookie header and the
 * holder of `accessPublicId`. UNAUTHORIZED without a valid portal session,
 * NOT_FOUND for any access the user may not use. Never reads a team session.
 */
export async function resolveInvestor(
  db: TPrismaOrTransaction,
  cookieHeader: string | null | undefined,
  accessPublicId: string,
  now: Date = new Date(),
): Promise<{
  portalUser: PortalUserContext;
  portalSessionId: string;
  holder: InvestorHolder;
  company: InvestorCompany;
}> {
  const found = await loadPortalSession(db, cookieHeader, now);
  if (found === null) throw new TRPCError({ code: "UNAUTHORIZED" });
  const resolved = await resolveHolder(
    db,
    found.portalUser.id,
    accessPublicId,
    now,
  );
  return {
    portalUser: found.portalUser,
    portalSessionId: found.sessionId,
    ...resolved,
  };
}

/** Every `investorProcedure` input carries the access it acts for. */
export const ZInvestorInput = z.object({ access: z.string().min(8).max(64) });

/** Middleware B on top of A: one holder, resolved from `input.access`. */
export const investorProcedure = portalSessionProcedure
  .input(ZInvestorInput)
  .use(async ({ ctx, input, next }) => {
    const { holder, company } = await resolveHolder(
      ctx.db,
      ctx.portalUser.id,
      input.access,
    );
    return next({ ctx: { ...ctx, holder, company } });
  });
