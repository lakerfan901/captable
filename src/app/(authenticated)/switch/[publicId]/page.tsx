import { redirect } from "next/navigation";
import { SwitchCompany } from "@/components/llc/switch-company";
import { safeNextPath } from "@/lib/safe-next-path";
import { withServerComponentSession } from "@/server/auth";
import { db } from "@/server/db";

type SwitchPageProps = {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function SwitchCompanyPage(props: SwitchPageProps) {
  const [{ publicId }, searchParams, session] = await Promise.all([
    props.params,
    props.searchParams,
    withServerComponentSession(),
  ]);

  // Membership is verified here from the database; the mutation the client
  // calls re-verifies it (id + userId + ACTIVE + onboarded) before switching.
  const member = await db.member.findFirst({
    where: {
      userId: session.user.id,
      status: "ACTIVE",
      isOnboarded: true,
      company: { publicId },
    },
    select: { id: true },
  });

  if (!member) {
    redirect(`/${session.user.companyPublicId}`);
  }

  const rawNext =
    typeof searchParams.next === "string" ? searchParams.next : undefined;
  const next = safeNextPath(publicId, rawNext);

  return <SwitchCompany memberId={member.id} next={next} />;
}
