import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from "react-email";

export interface AdmissionNoticeEmailProps {
  companyName: string;
  heading: string;
  lines: string[];
  cta: { label: string; url: string } | null;
}

// Notices of the Exhibit B flow (01-foundation.md F12): the W-9 request to
// the investor and the review notice to the Manager. Modelled on
// EsignConfirmationEmail.
const AdmissionNoticeEmail = ({
  companyName,
  heading,
  lines,
  cta,
}: AdmissionNoticeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{heading}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[465px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 mb-[15px] mt-5 p-0 text-center text-[24px] font-normal text-black">
              {companyName}
            </Heading>

            <Text className="text-[16px] font-semibold leading-[24px] text-black">
              {heading}
            </Text>

            {lines.map((line) => (
              <Text
                key={line}
                className="mt-4 text-[14px] leading-[24px] text-black"
              >
                {line}
              </Text>
            ))}

            {cta ? (
              <Section className="mb-[24px] mt-[24px] text-center">
                <Button
                  className="rounded bg-black px-5 py-3 text-center text-[12px] font-semibold text-white no-underline"
                  href={cta.url}
                >
                  {cta.label}
                </Button>
              </Section>
            ) : null}

            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="mx-auto text-center text-[12px] leading-[24px] text-[#666666]">
              Please ignore, if you were not expecting this email.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

AdmissionNoticeEmail.PreviewProps = {
  companyName: "Company Name",
  heading: "Please upload your Form W-9",
  lines: [
    "Thank you. Company Name has received your signed signature page. Please upload a completed IRS Form W-9 using the secure link below.",
  ],
  cta: { label: "Upload Form W-9", url: "https://example.com/w9/token" },
} satisfies AdmissionNoticeEmailProps;

export default AdmissionNoticeEmail;
