import {
  companyFooter,
  PortalEmailLayout,
  PortalEmailText,
} from "./PortalEmailLayout";

// Invitation to the investor portal for an address without a password
// (04-investor-portal.md 5.2 "Invitation", 5.8). Carries the set-password
// link (one use, 7 days). Rendered by the `portal.account-email` job only.

export interface PortalInviteEmailProps {
  companyName: string | null;
  holderName: string | null;
  link: string;
  /** "7 days" (account-email-core `expiryPhrase`). */
  expiresIn: string;
}

export const PortalInviteEmail = ({
  companyName,
  holderName,
  link,
  expiresIn,
}: PortalInviteEmailProps) => {
  const who = companyName ?? "The Manager";
  const what = holderName
    ? `documents and reports for ${holderName}`
    : "documents and reports";
  return (
    <PortalEmailLayout
      preview={`${who} invited you to its investor portal`}
      title="You are invited"
      action={{ label: "Set your password", href: link }}
      footer={companyFooter(companyName)}
    >
      <PortalEmailText>
        {who} invited you to view {what} in its investor portal. Set a password
        to start.
      </PortalEmailText>
      <PortalEmailText>
        The link works once and expires in {expiresIn}. If it has expired, use
        “Forgot password?” on the sign-in page to get a new one. If you did not
        expect this invitation, you can ignore this email.
      </PortalEmailText>
    </PortalEmailLayout>
  );
};

PortalInviteEmail.PreviewProps = {
  companyName: "Example Compute LLC",
  holderName: "Bexley Family Trust",
  link: "https://captable.inc/portal/set-password/...",
  expiresIn: "7 days",
} as PortalInviteEmailProps;

export default PortalInviteEmail;
