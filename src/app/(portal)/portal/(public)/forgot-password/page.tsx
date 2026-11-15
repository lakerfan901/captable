import { connection } from "next/server";
import { PortalForgotPasswordForm } from "@/components/portal/forgot-password-form";

// /portal/forgot-password (04-investor-portal.md 5.2, 6.1; packages P2b,
// P8a). Email field; afterwards the neutral sentence, whatever the address.
// Rendered per request like every portal page (never prerendered or cached).

export default async function PortalForgotPasswordPage() {
  await connection();
  return <PortalForgotPasswordForm />;
}
