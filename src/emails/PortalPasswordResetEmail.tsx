import {
  ACCOUNT_FOOTER,
  PortalEmailLayout,
  PortalEmailText,
} from "./PortalEmailLayout";

// Password reset link (04-investor-portal.md 5.2 "Forgot password", 5.8):
// one use, 60 minutes. Also completes an invitation for a user who never set
// a password.

export interface PortalPasswordResetEmailProps {
  link: string;
  /** "60 minutes" (account-email-core `expiryPhrase`). */
  expiresIn: string;
}

export const PortalPasswordResetEmail = ({
  link,
  expiresIn,
}: PortalPasswordResetEmailProps) => (
  <PortalEmailLayout
    preview="Set a new password for the investor portal"
    title="Set a new password"
    action={{ label: "Set a new password", href: link }}
    footer={ACCOUNT_FOOTER}
  >
    <PortalEmailText>
      Use this link to set a new password for the investor portal. It works once
      and expires in {expiresIn}. Setting a password also ends a sign-in lock
      and signs out every other browser.
    </PortalEmailText>
    <PortalEmailText>
      If you did not ask for this, ignore this email: your password stays as it
      is.
    </PortalEmailText>
  </PortalEmailLayout>
);

PortalPasswordResetEmail.PreviewProps = {
  link: "https://captable.inc/portal/set-password/...",
  expiresIn: "60 minutes",
} as PortalPasswordResetEmailProps;

export default PortalPasswordResetEmail;
