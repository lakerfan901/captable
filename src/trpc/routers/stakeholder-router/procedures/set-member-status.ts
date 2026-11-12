import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZSetMemberStatusInput } from "../member-schema";
import { toMemberDTO } from "./get-member";

/**
 * Moves a holder between MEMBER and FINANCIAL_INTEREST_ONLY (Sections 1.8,
 * 1.11, 7.9.2). A PROSPECT becomes a member only through acceptance (F6).
 */
export const setMemberStatusProcedure = withLlcAccessControl
  .meta({ policies: { stakeholder: { allow: ["update"] } } })
  .input(ZSetMemberStatusInput)
  .mutation(
    ({ ctx: { db, membership, session, userAgent, requestIp }, input }) => {
      const { companyId } = membership;
      const user = session.user;

      return db.$transaction(async (tx) => {
        const existing = await tx.stakeholder.findFirst({
          where: { id: input.id, companyId },
          select: { id: true, memberStatus: true },
        });
        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Member not found.",
          });
        }
        if (
          existing.memberStatus === "PROSPECT" ||
          existing.memberStatus === input.memberStatus
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Status can only change between Member and Financial interest only; a prospect is admitted through acceptance (Sections 1.8, 1.11, 7.9.2).",
          });
        }

        const updated = await tx.stakeholder.update({
          where: { id: input.id, companyId },
          data: { memberStatus: input.memberStatus },
        });

        await Audit.create(
          {
            action: "stakeholder.updated",
            companyId,
            actor: { type: "user", id: user.id },
            context: { userAgent, requestIp },
            target: [{ type: "stakeholder", id: updated.id }],
            summary: `${user.name} changed the status of ${updated.name} from ${existing.memberStatus} to ${input.memberStatus}. Reason: ${input.reason}`,
          },
          tx,
        );

        return toMemberDTO(updated);
      });
    },
  );
