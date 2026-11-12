import { redirect } from "next/navigation";
import { withServerComponentSession } from "@/server/auth";

export default async function OnboardedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await withServerComponentSession();

  if (!session.user.isOnboarded) {
    redirect("/onboarding");
  }

  return <>{children}</>;
}
