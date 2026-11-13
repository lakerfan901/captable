import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "react-email";

// Ballot invite and reminder (03-governance.md G9, "Email copy").

export interface BallotInviteEmailProps {
  kind: "INVITE" | "REMINDER";
  companyName: string;
  recipientName: string | null | undefined;
  title: string;
  referenceCode: string;
  /** Long-form record date, e.g. "November 1, 2026". */
  recordDate: string;
  /** Preferred Units of record, formatted. */
  units: string;
  /** Long-form close date-time in the governance time zone. */
  closesAt: string;
  /** Adds the Section 2.5 deemed-against sentence (TERM_EXTENSION only). */
  isTermExtension: boolean;
  link: string;
}

export function ballotEmailSubject(input: {
  kind: "INVITE" | "REMINDER";
  title: string;
  companyName: string;
  closesAtDate: string;
}): string {
  return input.kind === "INVITE"
    ? `Action requested: ${input.title} — ${input.companyName}`
    : `Reminder: response due ${input.closesAtDate} — ${input.title}`;
}

export function noticeFooter(companyName: string): string {
  return `This message is a notice from ${companyName} sent to the email address on file for you under Section 13.6 of the Operating Agreement.`;
}

export const BallotInviteEmail = ({
  kind,
  companyName,
  recipientName,
  title,
  referenceCode,
  recordDate,
  units,
  closesAt,
  isTermExtension,
  link,
}: BallotInviteEmailProps) => {
  const firstName = recipientName?.trim().split(/\s+/)[0] || "there";
  const previewText = `${companyName} asks for your written consent: ${title}`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[465px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-black">
              {companyName} - <strong>{title}</strong>
            </Heading>
            {kind === "REMINDER" && (
              <Text className="text-[14px] leading-[24px] text-black">
                This is a reminder that your response has not yet been received.
              </Text>
            )}
            <Text className="text-[14px] leading-[24px] text-black">
              Hello {firstName},
            </Text>
            <Text className="text-[14px] leading-[24px] text-black">
              {companyName} asks for your written consent on the following
              matter:
            </Text>
            <Text className="text-[14px] leading-[24px] text-black">
              <strong>{title}</strong> ({referenceCode})
            </Text>
            <Text className="text-[14px] leading-[24px] text-black">
              Your Preferred Units of record on {recordDate}: {units}
            </Text>
            <Text className="text-[14px] leading-[24px] text-black">
              Please respond by {closesAt}.
            </Text>
            {isTermExtension && (
              <Text className="text-[14px] leading-[24px] text-black">
                Under Section 2.5 of the Operating Agreement, a Preferred Member
                who does not respond within 30 days is deemed to have voted
                against the extension.
              </Text>
            )}

            <Section className="mb-[32px] mt-[32px]">
              <Button
                className="rounded bg-black px-5 py-3 text-center text-[12px] font-semibold text-white no-underline"
                href={link}
              >
                Review and respond
              </Button>
            </Section>

            <Text className="text-[14px]! leading-[24px] text-black">
              or copy and paste this URL into your browser:{" "}
              <Link
                href={link}
                className="break-all text-blue-600 no-underline"
              >
                {link}
              </Link>
            </Text>
            <Text className="text-[14px] leading-[24px] text-black">
              This link is personal to you. Please do not forward it.
            </Text>

            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-xs text-gray-400!">
              {noticeFooter(companyName)}
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

BallotInviteEmail.PreviewProps = {
  kind: "INVITE",
  companyName: "Example Compute LLC",
  recipientName: "Will Smith",
  title: "Extension of the Term",
  referenceCode: "R-2026-001",
  recordDate: "November 1, 2026",
  units: "1,050",
  closesAt: "December 1, 2026 11:59 PM MST",
  isTermExtension: true,
  link: "https://captable.inc/ballots/...",
} as BallotInviteEmailProps;

export default BallotInviteEmail;
