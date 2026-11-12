import { Audit } from "@/server/audit";
import { checkMembership } from "@/server/auth";
import { revokeExistingInviteTokens } from "@/server/member";
import { withAccessControl } from "@/trpc/api/trpc";
import { TRPCError } from "@trpc/server";
import { ZodRevokeInviteMutationSchema } from "../schema";
import { removeMemberHandler } from "./remove-member";

export const revokeInviteProcedure = withAccessControl
  .input(ZodRevokeInviteMutationSchema)
  .meta({ policies: { members: { allow: ["delete"] } } })
  .mutation(async ({ ctx, input }) => {
    const { db, session, requestIp, userAgent } = ctx;
    const user = session.user;
    const { memberId, email } = input;

    await db.$transaction(async (tx) => {
      const { companyId } = await checkMembership({ session, tx });

      const member = await tx.member.findFirst({
        where: {
          id: memberId,
          companyId,
        },
        select: {
          userId: true,
          user: {
            select: {
              name: true,
            },
          },
          company: {
            select: {
              name: true,
            },
          },
        },
      });

      if (!member) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      await revokeExistingInviteTokens({ memberId, email, tx });

      await Audit.create(
        {
          action: "member.revoked-invite",
          companyId,
          actor: { type: "user", id: user.id },
          context: {
            requestIp,
            userAgent,
          },
          target: [{ type: "user", id: member?.userId }],
          summary: `${user.name} revoked ${member?.user?.name} to join ${member?.company?.name}`,
        },
        tx,
      );

      await removeMemberHandler({
        ctx: { ...ctx, db: tx },
        input: { memberId: input.memberId },
      });
    });

    return { success: true };
  });
