import { z } from "zod";
import { encode } from "@/lib/jwt";
import { checkMembership } from "@/server/auth";
import { withAuth } from "@/trpc/api/trpc";

export const getUpdatesProcedure = withAuth.query(async ({ ctx }) => {
  const { db, session } = ctx;
  const { companyId } = await checkMembership({ session, tx: db });

  const data = await db.update.findMany({
    where: {
      companyId,
    },
    include: {
      recipients: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return { data };
});

export const getRecipientsProcedure = withAuth
  .input(z.object({ updateId: z.string() }))
  .query(async ({ ctx, input }) => {
    const { db, session } = ctx;

    const { updateId } = input;
    const { companyId } = await checkMembership({ session, tx: db });

    const data = await db.updateRecipient.findMany({
      where: {
        update: {
          id: updateId,
          companyId: companyId,
        },
      },
    });

    const recipients = await Promise.all(
      data.map(async (recipient) => ({
        ...recipient,
        token: await encode({
          updateId,
          companyId,
          recipientId: recipient.id,
        }),
      })),
    );

    return recipients;
  });
