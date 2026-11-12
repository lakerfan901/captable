import { redirect } from "next/navigation";
import { getServerComponentAuthSession } from "@/server/auth";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerComponentAuthSession();

  if (!session) {
    redirect("/login");
  }
  return <>{children}</>;
}
