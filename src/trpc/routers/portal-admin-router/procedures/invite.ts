// portalAdmin.invite (04-investor-portal.md 5.2 "Invitation", 5.6; rules P1,
// P3, P29, P30; package P3).
//
// The only way a portal access comes into existence from the member page:
// a Manager user with `portal: create` confirms an address for one holder.
// Refused before any write while production mail goes to the mail catcher.
// The answer says only whether something was sent: never which email
// (invitation or "access added"), because that would tell the team the
// person already has a portal account elsewhere.
import { TRPCError } from "@trpc/server";
import { assertMailDeliverable } from "@/server/mail-delivery";
import {
  InviteRefusedError,
  inviteHolder,
  queueInviteEmail,
} from "@/server/portal/invite";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZInviteInput } from "../schema";
import { auditContext, TX_OPTIONS } from "./shared";

export const inviteProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["create"] } } })
  .input(ZInviteInput)
  .mutation(async ({ ctx, input }) => {
    // P30: before anything is written.
    assertMailDeliverable("MEMBER_EMAIL");

    const context = auditContext(ctx);
    let result: Awaited<ReturnType<typeof inviteHolder>>;
    try {
      result = await ctx.db.$transaction(
        (tx) =>
          inviteHolder(tx, {
            companyId: ctx.membership.companyId,
            stakeholderId: input.stakeholderId,
            email: input.email,
            name: input.name,
            invitedById: ctx.membership.memberId,
            reactivateDisabled: true,
            audit: {
              actorUserId: ctx.session.user.id,
              actorName: ctx.session.user.name ?? "A user",
              ...context,
            },
          }),
        TX_OPTIONS,
      );
    } catch (error) {
      if (error instanceof InviteRefusedError) {
        throw new TRPCError({
          code:
            error.reason === "HOLDER_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST",
          message: error.message,
        });
      }
      throw error;
    }

    // After commit only: the access exists whether or not the queue answers.
    await queueInviteEmail(result);

    return {
      accessId: result.accessPublicId,
      email: result.email,
      outcome: result.outcome,
      sent: result.emailKind !== null,
    };
  });
