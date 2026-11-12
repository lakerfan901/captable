import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUpdateMemberInput } from "../member-schema";
import { DUPLICATE_MEMBER_EMAIL } from "./create-member";
import { isUniqueViolation, toMemberDTO } from "./get-member";

export const updateMemberProcedure = withLlcAccessControl
  .meta({ policies: { stakeholder: { allow: ["update"] } } })
  .input(ZUpdateMemberInput)
  .mutation(
    async ({
      ctx: { db, membership, session, userAgent, requestIp },
      input,
    }) => {
      const { companyId } = membership;
      const user = session.user;
      const { id, ...data } = input;
      try {
        return await db.$transaction(async (tx) => {
          const existing = await tx.stakeholder.findFirst({
            where: { id, companyId },
            select: { id: true },
          });
          if (!existing) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Member not found.",
            });
          }

          // Never changes memberStatus or admittedOn (not in the input).
          // The edit form always submits every field, so an optional field
          // that is absent means the Manager cleared it.
          const updated = await tx.stakeholder.update({
            where: { id, companyId },
            data: {
              ...data,
              residenceState: data.residenceState ?? null,
              accreditationBasis: data.accreditationBasis ?? null,
              signerName: data.signerName || null,
              signerTitle: data.signerTitle || null,
              noticeEmail: data.noticeEmail ?? null,
              phone: data.phone || null,
              streetAddress: data.streetAddress || null,
              city: data.city || null,
              state: data.state ?? null,
              zipcode: data.zipcode || null,
            },
          });

          await Audit.create(
            {
              action: "stakeholder.updated",
              companyId,
              actor: { type: "user", id: user.id },
              context: { userAgent, requestIp },
              target: [{ type: "stakeholder", id: updated.id }],
              summary: `${user.name} updated member ${updated.name}`,
            },
            tx,
          );

          return toMemberDTO(updated);
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
