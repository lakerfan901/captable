import type { Metadata } from "next";
import { PortalForgotPasswordForm } from "@/components/portal/forgot-password-form";

// /portal/forgot-password (04-investor-portal.md 5.2, 6.1; package P2b).
// Email field; afterwards the neutral sentence, whatever the address.

export const metadata: Metadata = {
  title: { absolute: "Investor portal" },
  robots: { index: false, follow: false },
};

export default function PortalForgotPasswordPage() {
  return <PortalForgotPasswordForm />;
}
