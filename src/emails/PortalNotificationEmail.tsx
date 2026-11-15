import { Section } from "react-email";
import { documentCountPhrase } from "@/lib/portal/notification-core";
import {
  companyFooter,
  PortalEmailLayout,
  PortalEmailText,
} from "./PortalEmailLayout";

// "New documents in the investor portal" (04-investor-portal.md 5.8;
// package P10). Sent only when the Manager user ticked "notify" in the share
// dialog. Carries the company name, the names of the holders THIS person has
// access to that gained documents, how many each gained, and a plain link to
// the sign-in page. No document name, no file, no token. Rendered by the
// `portal.notification-email` job only.

export interface PortalNotificationEmailProps {
  companyName: string | null;
  /** Holders this person has ACTIVE access to that gained documents (at least one). */
  holders: { name: string; documentCount: number }[];
  /** `{BASE}/portal/sign-in`, with `?next=` to the documents page for one holder. */
  signInUrl: string;
}

export const PortalNotificationEmail = ({
  companyName,
  holders,
  signInUrl,
}: PortalNotificationEmailProps) => {
  const who = companyName ?? "The Manager";
  const only = holders.length === 1 ? holders[0] : undefined;
  return (
    <PortalEmailLayout
      preview={
        only
          ? `${who} shared ${documentCountPhrase(only.documentCount)} for ${only.name}`
          : `${who} shared new documents in the investor portal`
      }
      title="New documents"
      action={{ label: "Sign in to see them", href: signInUrl }}
      footer={companyFooter(companyName)}
    >
      {only ? (
        <PortalEmailText>
          {who} shared {documentCountPhrase(only.documentCount)} for {only.name}{" "}
          in the investor portal.
        </PortalEmailText>
      ) : (
        <>
          <PortalEmailText>
            {who} shared new documents in the investor portal:
          </PortalEmailText>
          <Section>
            {holders.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static list rendered once
              <PortalEmailText key={i}>
                {h.name}: {documentCountPhrase(h.documentCount)}
              </PortalEmailText>
            ))}
          </Section>
        </>
      )}
      <PortalEmailText>
        Sign in with your existing password to open them. No files are attached
        to this email.
      </PortalEmailText>
    </PortalEmailLayout>
  );
};

PortalNotificationEmail.PreviewProps = {
  companyName: "Example Compute LLC",
  holders: [{ name: "Bexley Children's Trust", documentCount: 3 }],
  signInUrl:
    "https://captable.inc/portal/sign-in?next=%2Fportal%2Fabc123def456%2Fdocuments",
} as PortalNotificationEmailProps;

export default PortalNotificationEmail;
