import { generatePublicId } from "@/common/id";
import { sanitizeUpdateHtml } from "@/lib/sanitize-update-html";
import { Audit } from "@/server/audit";
import { checkMembership } from "@/server/auth";
import { withAuth } from "@/trpc/api/trpc";
import { UpdateMutationSchema } from "../schema";

export const cloneUpdateProcedure = withAuth
  .input(UpdateMutationSchema)
  .mutation(async ({ ctx, input }) => {
    try {
      const userId = ctx.session.user.id;
      const userName = ctx.session.user.name;
      const { userAgent, requestIp } = ctx;
      const publicId = generatePublicId();
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

        const update = await tx.update.create({
          data: {
            html,
            title: `Copy of - ${title}`,
            content,
            publicId,
            companyId,
            authorId,
          },
        });
        await Audit.create(
          {
            action: "update.cloned",
            companyId: companyId,
            actor: { type: "user", id: userId },
            context: {
              userAgent,
              requestIp,
            },
            target: [{ type: "update", id: update.id }],
            summary: `${userName} Cloned the Update ${title} for the company with id ${companyId}`,
          },
          tx,
        );
      });

      return {
        publicId,
        success: true,
        message: "Successfully cloned an update.",
      };
    } catch (error) {
      console.error("Error cloning an update:", error);
      return {
        success: false,
        message: "Oops, something went wrong. Please try again later.",
      };
    }
  });
