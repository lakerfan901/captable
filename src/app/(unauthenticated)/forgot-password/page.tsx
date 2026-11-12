import type { Metadata } from "next";
import ForgotPassword from "@/components/onboarding/forgot-password";

export const metadata: Metadata = {
  title: "Forgot Password",
};
export default function ForgotPasswordPage() {
  return <ForgotPassword />;
}
