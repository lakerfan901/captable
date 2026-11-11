import { SetPasswordForm } from "@/components/onboarding/set-password";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Set Password",
};

export type PageProps = {
  params: Promise<{
    token: string;
  }>;
  searchParams: Promise<{
    verificationToken: string;
    email: string;
  }>;
};

export default async function SetPasswordPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const params = await props.params;

  const { token } = params;

  const verificationToken = searchParams.verificationToken;
  const email = searchParams.email;

  if (!verificationToken || !email) {
    redirect("/set-password");
  }

  return (
    <SetPasswordForm
      token={token}
      email={email}
      verificationToken={verificationToken}
    />
  );
}
