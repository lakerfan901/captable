import { TRPCError } from "@trpc/server";
import { resetRequestAllowed } from "@/lib/portal/throttle-core";
import type { TPrisma } from "@/server/db";
import { currentMailDelivery } from "@/server/mail-delivery";
import { issueToken, lockPortalUser } from "@/server/portal/account";
import { emitPortalAccountEmail } from "@/server/portal/account-email";
import { withoutAuth } from "@/trpc/api/trpc";
import { reportLandingPath } from "../access";
import { ZReportTokenSchema } from "../schema";
import { resolveRecipient } from "./resolve";

// memberReportView.requestSetup (04-investor-portal.md P25 row "ACTIVE,
// password not yet set", 5.5, S15; package P5b). Public: the token is the
// credential. "Email me my set-up link" on the emailed-link page.
//
// Always `{ ok: true }`, whatever the token and whatever happened: an
// invalid or replaced link, a report in any other state, a throttled
// address and a sent link all answer the same. The one other answer,
// `UNAVAILABLE`, depends only on the deployment (production while mail goes
// to the mail catcher; as `portalAuth.requestReset`) and is decided before
// any look-up.
//
// A link is issued only when the token resolves to PORTAL with
// `setupNeeded`: the report is published and the addressee (the portal user
// whose email equals the recipient's address, among the accesses of THIS
// recipient's holder) has an ACTIVE access and no password. Under that
// user's row lock the conditions are re-checked, the per-address throttle of
// "Forgot password" applies (3 tokens in 15 minutes, 10 in 24 hours,
// counted over every token the user was sent, invitations included), and a
// SET_PASSWORD token (7 days) is issued with `nextPath` =
// `/portal/go/report/{report public id}`, never the token (P26, S16).
// After commit the invitation email is queued for that access; it goes to
// the portal user's own address on file, never to the browser (S15). Issuing
// retires the user's older unused set-password links (5.2 "Tokens").
//
// Rate-limited per IP by the proxy (`account` bucket, P0). The token is
// never logged, stored or put in an error.

/** Every answer takes at least this long (as `portalAuth.requestReset`). */
export const SETUP_MIN_RESPONSE_MS = 250;

async function issueSetupLink(
  db: TPrisma,
  input: { token: string; requestIp: string; now: Date },
): Promise<void> {
  let resolved: Awaited<ReturnType<typeof resolveRecipient>>;
  try {
    resolved = await resolveRecipient(db, input.token, input.now);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") return;
    throw error;
  }
  if (resolved.kind !== "PORTAL" || !resolved.setupNeeded) return;
  const { accessId, portalUserId } = resolved.addressee;
  const now = input.now;

  const issued = await db.$transaction(
    async (tx) => {
      const user = await lockPortalUser(tx, portalUserId);
      if (user === null || user.passwordHash !== null) return null;
      const access = await tx.portalAccess.findFirst({
        where: { id: accessId, portalUserId, status: "ACTIVE" },
        select: { id: true },
      });
      if (access === null) return null;
      const recent = await tx.portalAccountToken.findMany({
        where: {
          portalUserId,
          createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) },
        },
        select: { createdAt: true },
      });
      if (
        !resetRequestAllowed(
          recent.map((r) => r.createdAt),
          now,
        )
      ) {
        return null;
      }
      return issueToken(tx, {
        portalUserId,
        purpose: "SET_PASSWORD",
        nextPath: reportLandingPath(resolved.reportPublicId),
        requestIp: input.requestIp,
        now,
      });
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
  if (issued !== null) {
    await emitPortalAccountEmail({
      kind: "INVITE",
      tokenId: issued.tokenId,
      accessId,
    });
  }
}

export const requestSetupProcedure = withoutAuth
  .input(ZReportTokenSchema)
  .mutation(async ({ ctx, input }) => {
    if (currentMailDelivery("MEMBER_EMAIL").blockedReason !== null) {
      return { ok: false as const, reason: "UNAVAILABLE" as const };
    }
    const floor = Date.now() + SETUP_MIN_RESPONSE_MS;
    try {
      await issueSetupLink(ctx.db, {
        token: input.token,
        requestIp: ctx.requestIp,
        now: new Date(),
      });
    } finally {
      const wait = floor - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return { ok: true as const };
  });
