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
import { noticeFooter } from "./BallotInviteEmail";

// Member report delivery (03-governance.md G12, "Email copy") and the
// "your report link was re-issued to another address" security notice.

export type MemberReportEmailType =
  | "QUARTERLY"
  | "ANNUAL"
  | "TAX_K1"
  | "NOTICE";

export interface MemberReportEmailProps {
  type: MemberReportEmailType;
  companyName: string;
  recipientName: string | null | undefined;
  title: string;
  /** QUARTERLY: the period, e.g. "Q4 2026". */
  period: string;
  /** ANNUAL / TAX_K1: the fiscal (tax) year. */
  fiscalYear: string;
  /** Long-form date until which the link works. */
  validUntil: string;
  link: string;
}

export const CONFIDENTIALITY_LINE =
  "Confidential. Provided under Section 8.3 of the Operating Agreement.";

export function memberReportEmailSubject(input: {
  companyName: string;
  title: string;
}): string {
  return `${input.companyName}: ${input.title}`;
}

function firstNameOf(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || "there";
}

export function memberReportIntro(
  p: Pick<
    MemberReportEmailProps,
    "type" | "companyName" | "title" | "period" | "fiscalYear"
  >,
): string {
  switch (p.type) {
    case "QUARTERLY":
      return `The quarterly report of ${p.companyName} for ${p.period} is available.`;
    case "ANNUAL":
      return `The annual financial statements of ${p.companyName} for fiscal year ${p.fiscalYear} are available.`;
    case "TAX_K1":
      return `Your Schedule K-1 from ${p.companyName} for tax year ${p.fiscalYear} is available.`;
    case "NOTICE":
      return `${p.companyName} has sent you a notice: ${p.title}.`;
  }
}

export const MemberReportEmail = (props: MemberReportEmailProps) => {
  const { companyName, recipientName, title, validUntil, link } = props;
  const intro = memberReportIntro(props);
  return (
    <Html>
      <Head />
      <Preview>{intro}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[465px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-black">
              {companyName} - <strong>{title}</strong>
            </Heading>
            <Text className="text-[14px] leading-[24px] text-black">
              Hello {firstNameOf(recipientName)},
            </Text>
            <Text className="text-[14px] leading-[24px] text-black">
              {intro}
            </Text>

            <Section className="mb-[32px] mt-[32px]">
              <Button
                className="rounded bg-black px-5 py-3 text-center text-[12px] font-semibold text-white no-underline"
                href={link}
              >
                View
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
              This link is personal to you and is valid until {validUntil}.
              Please do not forward it.
            </Text>

            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-xs text-gray-400!">
              {CONFIDENTIALITY_LINE}
            </Text>
            <Text className="text-xs text-gray-400!">
              {noticeFooter(companyName)}
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

MemberReportEmail.PreviewProps = {
  type: "QUARTERLY",
  companyName: "Example Compute LLC",
  recipientName: "Will Smith",
  title: "Q4 2026 report to Members",
  period: "Q4 2026",
  fiscalYear: "2026",
  validUntil: "February 18, 2028",
  link: "https://captable.inc/member-reports/...",
} as MemberReportEmailProps;

// Security notice: the report link of a holder was re-issued to a different
// email address. Sent to the previous address and to the holder's notice
// email on file, never to the new address. Deliberately carries NO link.

export interface MemberReportAddressChangedEmailProps {
  companyName: string;
  recipientName: string | null | undefined;
  title: string;
}

export function memberReportAddressChangedSubject(input: {
  companyName: string;
  title: string;
}): string {
  return `Your report link was re-issued: ${input.title} — ${input.companyName}`;
}

export const MemberReportAddressChangedEmail = ({
  companyName,
  recipientName,
  title,
}: MemberReportAddressChangedEmailProps) => (
  <Html>
    <Head />
    <Preview>{`Your link to ${title} was re-issued`}</Preview>
    <Tailwind>
      <Body className="mx-auto my-auto bg-white font-sans">
        <Container className="mx-auto my-[40px] max-w-[465px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
          <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-black">
            {companyName} - <strong>Report link re-issued</strong>
          </Heading>
          <Text className="text-[14px] leading-[24px] text-black">
            Hello {firstNameOf(recipientName)},
          </Text>
          <Text className="text-[14px] leading-[24px] text-black">
            Your personal link to <strong>{title}</strong> was re-issued to a
            different email address. Your previous link no longer works.
          </Text>
          <Text className="text-[14px] leading-[24px] text-black">
            If you did not ask for this, contact the Manager of {companyName}.
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

export default MemberReportEmail;
