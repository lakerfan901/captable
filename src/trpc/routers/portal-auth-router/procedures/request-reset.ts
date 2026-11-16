// portalAuth.requestReset (04-investor-portal.md 5.2 "Forgot password", 5.4;
// package P2a). Public: the only portal procedure that needs no session.
//
// Always `{ ok: true }` whatever the address (S10): known or unknown, with or
// without a password, with or without ACTIVE access, throttled or not. The
// email is queued for a job, so the answer does not wait for SMTP. The one
// other answer, `UNAVAILABLE`, depends only on the deployment (production
// while mail goes to the mail catcher) and is decided before any look-up.
// Rate-limited per IP by the proxy (`account` bucket, P0) and per address
// in the database (throttle-core).

import { z } from "zod";
import { logger } from "@/lib/logger";
import { currentMailDelivery } from "@/server/mail-delivery";
import { requestPasswordReset } from "@/server/portal/account";
import { withoutAuth } from "@/trpc/api/trpc";

export const ZRequestResetInput = z.object({
  // Normalized (trim, NFC, lower-case, shape) by `normalizePortalEmail`
  // inside; an address it rejects gets the same answer.
  email: z.string().max(254),
});

/**
 * Every answer takes at least this long. An unknown address returns after
 * one read, a known one after a locked transaction and an enqueue (tens of
 * milliseconds); padding both to the same floor removes that difference
 * (S10). Well above the measured work, well below what a person notices.
 */
export const RESET_MIN_RESPONSE_MS = 250;

const log = logger.child({ module: "portal-request-reset" });

export const requestResetProcedure = withoutAuth
  .input(ZRequestResetInput)
  .mutation(async ({ ctx, input }) => {
    if (currentMailDelivery("MEMBER_EMAIL").blockedReason !== null) {
      return { ok: false as const, reason: "UNAVAILABLE" as const };
    }
    const floor = Date.now() + RESET_MIN_RESPONSE_MS;
    try {
      await requestPasswordReset(ctx.db, {
        email: input.email,
        requestIp: ctx.requestIp,
      });
    } catch (error) {
      // S10: a failure (a transaction timeout, say) can happen only for a
      // known address, so it is logged and answered like every request.
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "[Portal] password reset request failed",
      );
    } finally {
      const wait = floor - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return { ok: true as const };
  });
