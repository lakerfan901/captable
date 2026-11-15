import {
  companyFooter,
  PortalEmailLayout,
  PortalEmailText,
} from "./PortalEmailLayout";

// "You now also have access to {holder} at {company}" (04-investor-portal.md
// 5.2 "Invitation", 5.8): the address already has a password, so the email
// carries no token, only the sign-in page.

export interface PortalAccessAddedEmailProps {
  companyName: string | null;
  holderName: string | null;
  /** `{NEXT_PUBLIC_BASE_URL}/portal/sign-in` */
  signInUrl: string;
}

export const PortalAccessAddedEmail = ({
  companyName,
  holderName,
  signInUrl,
}: PortalAccessAddedEmailProps) => {
  const who = companyName ?? "The Manager";
  const what = holderName
    ? `documents and reports for ${holderName}`
    : "documents and reports for one more holder";
  return (
    <PortalEmailLayout
      preview={`You now also have access to ${holderName ?? "another holder"}`}
      title="New access"
      action={{ label: "Open the investor portal", href: signInUrl }}
      footer={companyFooter(companyName)}
    >
      <PortalEmailText>
        {who} gave you access to {what}. Sign in with your existing password.
      </PortalEmailText>
    </PortalEmailLayout>
  );
};

PortalAccessAddedEmail.PreviewProps = {
  companyName: "Example Compute LLC",
  holderName: "Bexley Children's Trust",
  signInUrl: "https://captable.inc/portal/sign-in",
} as PortalAccessAddedEmailProps;

export default PortalAccessAddedEmail;
