import { redirect } from "next/navigation";
import { getServerComponentAuthSession } from "@/server/auth";

export default async function HomePage() {
  const session = await getServerComponentAuthSession();

  if (session?.user?.companyPublicId) {
    return redirect(`/${session.user.companyPublicId}`);
  }

  return redirect("/login");
}
