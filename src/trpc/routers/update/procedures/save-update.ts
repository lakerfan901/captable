import { generatePublicId } from "@/common/id";
import { sanitizeUpdateHtml } from "@/lib/sanitize-update-html";
import { Audit } from "@/server/audit";
import { checkMembership } from "@/server/auth";
import { withAuth } from "@/trpc/api/trpc";
import { TRPCError } from "@trpc/server";
import { UpdateMutationSchema } from "../schema";

export const saveUpdateProcedure = withAuth
  .input(UpdateMutationSchema)
  .mutation(async ({ ctx, input }) => {
    try {
      const userId = ctx.session.user.id;
      const userName = ctx.session.user.name;
      const { userAgent, requestIp } = ctx;
      const publicId = input.publicId ?? generatePublicId();
      const { title, content } = input;
      const html = sanitizeUpdateHtml(input.html);

      if (title.length === 0 || content.length === 0) {
        return {
          success: false,
          message: "Title and content cannot be empty.",
        };
      }
      await ctx.db.$transaction(async (tx) => {
        const { companyId, memberId: authorId } = await checkMembership({
          session: ctx.session,
          tx,
        });

        if (input.publicId) {
          // Only an update of the caller's own company may be overwritten.
          const existing = await tx.update.findFirst({
            where: { publicId, companyId },
            select: { id: true },
          });

          if (!existing) {
            throw new TRPCError({ code: "NOT_FOUND" });
          }

          const update = await tx.update.update({
            where: { id: existing.id, companyId },
            data: {
              html,
              title,
              content,
            },
          });

          await Audit.create(
            {
              action: "update.updated",
              companyId: companyId,
              actor: { type: "user", id: userId },
              context: {
                userAgent,
                requestIp,
              },
              target: [{ type: "update", id: update.id }],
              summary: `${userName} updated an Update ${update.title} for the company with id ${companyId}`,
            },
            tx,
          );
        } else {
          const update = await tx.update.create({
            data: {
              html,
              title,
              content,
              publicId,
              companyId,
              authorId,
            },
          });

          await Audit.create(
            {
              action: "update.created",
              companyId: companyId,
              actor: { type: "user", id: userId },
              context: {
                userAgent,
                requestIp,
              },
              target: [{ type: "update", id: update.id }],
              summary: `${userName} created an Update ${update.title} for the company with id ${companyId}`,
            },
            tx,
          );
        }
      });

      return {
        publicId,
        success: true,
        message: "Successfully saved an update.",
      };
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      console.error("Error saving an update:", error);
      return {
        success: false,
        message: "Oops, something went wrong. Please try again later.",
      };
    }
  });
