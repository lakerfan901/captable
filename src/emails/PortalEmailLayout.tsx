import type { ReactNode } from "react";
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

// The frame shared by the investor portal account emails
// (04-investor-portal.md 5.8; package P2b): the same look as the other
// transactional emails (MemberReportEmail), a heading "Investor portal",
// optional button with the URL repeated as text, and a footer.

export function PortalEmailLayout(props: {
  preview: string;
  title: string;
  children: ReactNode;
  action?: { label: string; href: string };
  footer: string;
}) {
  return (
    <Html>
      <Head />
      <Preview>{props.preview}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[465px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Text className="m-0 mt-[16px] text-center text-[13px] font-semibold text-neutral-500">
              Investor portal
            </Text>
            <Heading className="mx-0 mb-[30px] mt-[8px] p-0 text-center text-[24px] font-normal text-black">
              {props.title}
            </Heading>
            {props.children}
            {props.action ? (
              <>
                <Section className="mb-[32px] mt-[32px]">
                  <Button
                    className="rounded bg-black px-5 py-3 text-center text-[12px] font-semibold text-white no-underline"
                    href={props.action.href}
                  >
                    {props.action.label}
                  </Button>
                </Section>
                <Text className="text-[14px]! leading-[24px] text-black">
                  or copy and paste this URL into your browser:{" "}
                  <Link
                    href={props.action.href}
                    className="break-all text-blue-600 no-underline"
                  >
                    {props.action.href}
                  </Link>
                </Text>
              </>
            ) : null}
            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-xs text-gray-400!">{props.footer}</Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

export function PortalEmailText({ children }: { children: ReactNode }) {
  return (
    <Text className="text-[14px] leading-[24px] text-black">{children}</Text>
  );
}

/** Footer of the emails about one company's access. */
export function companyFooter(companyName: string | null): string {
  return companyName
    ? `You received this email because ${companyName} gave this address access to its investor portal.`
    : "You received this email because this address was given access to an investor portal.";
}

/** Footer of the account security emails (no company: an account can serve several). */
export const ACCOUNT_FOOTER =
  "You received this email because this address has an investor portal account.";
