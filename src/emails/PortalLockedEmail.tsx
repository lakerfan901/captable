import {
  ACCOUNT_FOOTER,
  PortalEmailLayout,
  PortalEmailText,
} from "./PortalEmailLayout";

// "Sign-in is locked for 15 minutes" (04-investor-portal.md 5.2 step 4, 5.8,
// P6, S9): at most one a day per account. No link; says how to reset.

export interface PortalLockedEmailProps {
  email: string;
  /** "November 15, 2026 at 17:32 UTC" */
  lockedAt: string;
}

export const PortalLockedEmail = ({
  email,
  lockedAt,
}: PortalLockedEmailProps) => (
  <PortalEmailLayout
    preview="Investor portal sign-in is locked for 15 minutes"
    title="Sign-in locked"
    footer={ACCOUNT_FOOTER}
  >
    <PortalEmailText>
      Five wrong passwords in a row were entered for the investor portal account{" "}
      {email}, so sign-in was locked for 15 minutes on {lockedAt}.
    </PortalEmailText>
    <PortalEmailText>
      If this was you, wait 15 minutes and try again, or choose “Forgot
      password?” on the sign-in page: setting a new password also ends the lock.
      If it was not you, set a new password that way now.
    </PortalEmailText>
  </PortalEmailLayout>
);

PortalLockedEmail.PreviewProps = {
  email: "investor@example.com",
  lockedAt: "November 15, 2026 at 17:32 UTC",
} as PortalLockedEmailProps;

export default PortalLockedEmail;
