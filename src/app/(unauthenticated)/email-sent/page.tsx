import type { Metadata } from "next";
import EmailSent from "@/components/onboarding/email-sent";

export const metadata: Metadata = {
  title: "Email Sent",
};
export default function EmailSentPage() {
  return <EmailSent />;
}
