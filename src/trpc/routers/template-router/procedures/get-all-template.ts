import { checkMembership } from "@/server/auth";
import { withAuth } from "@/trpc/api/trpc";

export const getAllTemplateProcedure = withAuth.query(async ({ ctx }) => {
  const { documents } = await ctx.db.$transaction(async (tx) => {
    const { companyId } = await checkMembership({ tx, session: ctx.session });

    const documents = await tx.template.findMany({
      where: {
        companyId,
        // Subscription packets (one per investor) live on the Admissions
        // page, which applies the admission rules; masters stay listed so
        // their editor can be opened from here too.
        NOT: { workflow: "SUBSCRIPTION", isMaster: false },
      },
      select: {
        id: true,
        publicId: true,
        status: true,
        completedOn: true,
        name: true,
        createdAt: true,
        isMaster: true,
        workflow: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return { documents };
  });

  return { documents };
});
