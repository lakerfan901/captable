import { withServerSession } from "@/server/auth";

export const POST = async () => {
  // Session lookup kept: it throws for unauthenticated callers.
  await withServerSession();
};
