import { ResetPasswordForm } from "@/components/onboarding/reset-password";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reset Password",
};

export type PageProps = {
  params: Promise<{
    token: string;
  }>;
};

export default async function ResetPasswordPage(props: PageProps) {
  const params = await props.params;

  const { token } = params;

  return <ResetPasswordForm token={token} />;
}
