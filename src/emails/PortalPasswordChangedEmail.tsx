import {
  ACCOUNT_FOOTER,
  PortalEmailLayout,
  PortalEmailText,
} from "./PortalEmailLayout";

// "Your portal password was changed" (04-investor-portal.md 5.2, 5.8, S11).
// Deliberately carries NO link: it tells the owner of the mailbox, after a
// set, reset or change, so a stolen link or password announces itself.

export interface PortalPasswordChangedEmailProps {
  email: string;
  /** "November 15, 2026 at 17:32 UTC" */
  changedAt: string;
}

export const PortalPasswordChangedEmail = ({
  email,
  changedAt,
}: PortalPasswordChangedEmailProps) => (
  <PortalEmailLayout
    preview="Your investor portal password was changed"
    title="Password changed"
    footer={ACCOUNT_FOOTER}
  >
    <PortalEmailText>
      The password of the investor portal account {email} was set on {changedAt}
      . Every other browser that was signed in has been signed out.
    </PortalEmailText>
    <PortalEmailText>
      If this was you, there is nothing more to do. If it was not, open the
      investor portal sign-in page, choose “Forgot password?” to set a new
      password at once, and tell the Manager.
    </PortalEmailText>
  </PortalEmailLayout>
);

PortalPasswordChangedEmail.PreviewProps = {
  email: "investor@example.com",
  changedAt: "November 15, 2026 at 17:32 UTC",
} as PortalPasswordChangedEmailProps;

export default PortalPasswordChangedEmail;
