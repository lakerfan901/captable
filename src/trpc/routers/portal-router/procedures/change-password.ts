// portal.changePassword (04-investor-portal.md 5.2 "Change password", 5.4;
// package P2a).
//
// The signed-in user gives the current password and a new one. A wrong
// current password counts toward the lock (P6) and a locked account is
// refused, with one message for both. On success every OTHER session of the
// user is revoked, outstanding set-password and reset links stop working,
// and a "password changed" email is queued.
//
// Passwords: the input is not trimmed or normalised (the exact string the
// policy accepted is hashed), and never appears in an error. The field names
// `currentPassword` / `newPassword` are ones `redactSensitive` filters, and
// this base (`withoutAuth`) attaches no input to Sentry events anyway.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { PASSWORD_PROBLEM_MESSAGES } from "@/lib/portal/password-core";
import { changePassword } from "@/server/portal/account";
import { portalSessionProcedure } from "@/trpc/api/portal-procedure";

export const ZChangePasswordInput = z.object({
  // Bounded only to cap the work; the policy (72 bytes) decides the rest.
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});

export const CHANGE_PASSWORD_REFUSED_MESSAGE =
  "The current password is incorrect, or the account is temporarily locked.";

export const changePasswordProcedure = portalSessionProcedure
  .input(ZChangePasswordInput)
  .mutation(async ({ ctx, input }) => {
    const result = await changePassword(ctx.db, {
      portalUserId: ctx.portalUser.id,
      sessionId: ctx.portalSessionId,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      ip: ctx.requestIp,
      userAgent: ctx.userAgent,
    });
    if (result.ok) return { ok: true as const };
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        result.reason === "WEAK"
          ? PASSWORD_PROBLEM_MESSAGES[result.problem]
          : CHANGE_PASSWORD_REFUSED_MESSAGE,
    });
  });
