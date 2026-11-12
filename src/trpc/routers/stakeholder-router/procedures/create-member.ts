import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZCreateMemberInput } from "../member-schema";
import { isUniqueViolation, toMemberDTO } from "./get-member";

export const DUPLICATE_MEMBER_EMAIL =
  "Another member of this company already uses this email.";

export const createMemberProcedure = withLlcAccessControl
  .meta({ policies: { stakeholder: { allow: ["create"] } } })
  .input(ZCreateMemberInput)
  .mutation(
    async ({
      ctx: { db, membership, session, userAgent, requestIp },
      input,
    }) => {
      const { companyId } = membership;
      const user = session.user;
      try {
        return await db.$transaction(async (tx) => {
          const created = await tx.stakeholder.create({
            data: {
              ...input,
              companyId,
              currentRelationship: "INVESTOR",
              stakeholderType:
                input.holderType === "ENTITY" || input.holderType === "TRUST"
                  ? "INSTITUTION"
                  : "INDIVIDUAL",
              institutionName: null,
              memberStatus: "PROSPECT",
            },
          });

          await Audit.create(
            {
              action: "stakeholder.added",
              companyId,
              actor: { type: "user", id: user.id },
              context: { userAgent, requestIp },
              target: [{ type: "stakeholder", id: created.id }],
              summary: `${user.name} added member ${created.name}`,
            },
            tx,
          );

          return toMemberDTO(created);
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: DUPLICATE_MEMBER_EMAIL,
          });
        }
        throw error;
      }
    },
  );
