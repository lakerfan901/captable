import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import type { TPrismaOrTransaction } from "@/server/db";
import { withAuth } from "@/trpc/api/trpc";
import {
  type TypeZodCreateBucketMutationSchema,
  ZodCreateBucketMutationSchema,
} from "../schema";

interface createBucketHandlerOptions {
  input: TypeZodCreateBucketMutationSchema;
  db: TPrismaOrTransaction;
  userAgent: string;
  requestIp: string;
  user?: {
    name: string;
    companyId: string;
    id: string;
  };
}

export const createBucketHandler = async ({
  db,
  input,
  userAgent,
  requestIp,
  user,
}: createBucketHandlerOptions) => {
  const bucket = await db.bucket.create({ data: input });

  await Audit.create(
    {
      action: "bucket.created",
      companyId: user?.companyId || "",
      actor: { type: "user", id: user?.id || "" },
      context: {
        userAgent,
        requestIp,
      },
      target: [{ type: "bucket", id: bucket.id }],
      summary: `${user?.name} created the bucket ${bucket.name}`,
    },
    db,
  );

  return bucket;
};

export const createBucketProcedure = withAuth
  .input(ZodCreateBucketMutationSchema)
  .mutation(async ({ ctx: { db, userAgent, requestIp, session }, input }) => {
    const { name, companyId, companyPublicId, id } = session.user;

    // Browser uploads are always keyed under the caller's company publicId
    // (see `authorizeUpload`). Refuse to record any other key, so a member
    // cannot register another company's object under their own company.
    if (!companyPublicId || !input.key.startsWith(`${companyPublicId}/`)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Invalid file key" });
    }

    return await createBucketHandler({
      input,
      db,
      userAgent,
      requestIp,
      user: { name: name || "", companyId, id },
    });
  });
