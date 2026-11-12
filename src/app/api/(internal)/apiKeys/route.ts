import { withServerSession } from "@/server/auth";

export const POST = async (req: Request) => {
  const session = await withServerSession();
  const { user } = session;
};
