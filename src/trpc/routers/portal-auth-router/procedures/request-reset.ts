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
import { currentMailDelivery } from "@/server/mail-delivery";
import { requestPasswordReset } from "@/server/portal/account";
import { withoutAuth } from "@/trpc/api/trpc";

export const ZRequestResetInput = z.object({
  // Normalized (trim, NFC, lower-case, shape) by `normalizePortalEmail`
  // inside; an address it rejects gets the same answer.
  email: z.string().max(254),
});

export const requestResetProcedure = withoutAuth
  .input(ZRequestResetInput)
  .mutation(async ({ ctx, input }) => {
    if (currentMailDelivery("MEMBER_EMAIL").blockedReason !== null) {
      return { ok: false as const, reason: "UNAVAILABLE" as const };
    }
    await requestPasswordReset(ctx.db, {
      email: input.email,
      requestIp: ctx.requestIp,
    });
    return { ok: true as const };
  });
