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

// Result notice, purchase-order copy and Manager notification
// (03-governance.md G9, "Email copy").

export type ClosedResolutionStatus =
  | "EFFECTIVE"
  | "FAILED"
  | "EXPIRED"
  | "WITHDRAWN";

export const RESULT_LABEL: Record<ClosedResolutionStatus, string> = {
  EFFECTIVE: "Approved and effective",
  FAILED: "Not approved",
  EXPIRED: "Closed without approval",
  WITHDRAWN: "Withdrawn",
};

export function resultSentence(input: {
  status: ClosedResolutionStatus;
  effectiveAt: string;
  closedAt: string;
}): string {
  switch (input.status) {
    case "EFFECTIVE":
      return `The matter below was approved and became effective on ${input.effectiveAt}.`;
    case "FAILED":
      return "The matter below did not receive the required approval.";
    case "EXPIRED":
      return `The response period for the matter below ended on ${input.closedAt} without the required approval.`;
    case "WITHDRAWN":
      return `The Manager withdrew the matter below on ${input.closedAt}.`;
  }
}

interface CommonProps {
  companyName: string;
  recipientName: string | null | undefined;
  title: string;
  referenceCode: string;
}

export type ResolutionNoticeEmailProps = CommonProps &
  (
    | {
        variant: "RESULT";
        status: ClosedResolutionStatus;
        sentence: string;
        withdrawnReason: string | null;
        tallyLines: string[];
        /** Ballot link, only when the recipient has a ballot with a live link. */
        link: string | null;
      }
    | {
        variant: "PO_COPY";
        vendor: string;
        equipment: string;
        currency: string;
        price: string;
        effectiveAt: string;
        approverName: string;
        approverCapacity: string;
      }
    | {
        variant: "MANAGER";
        sentence: string;
        withdrawnReason: string | null;
        tallyLines: string[];
        link: string;
      }
  );

const P = "text-[14px] leading-[24px] text-black";

function Matter({ title, referenceCode }: CommonProps) {
  return (
    <Text className={P}>
      <strong>{title}</strong> ({referenceCode})
    </Text>
  );
}

function LinkBlock({ link, label }: { link: string; label: string }) {
  return (
    <>
      <Section className="mb-[32px] mt-[32px]">
        <Button
          className="rounded bg-black px-5 py-3 text-center text-[12px] font-semibold text-white no-underline"
          href={link}
        >
          {label}
        </Button>
      </Section>
      <Text className="text-[14px]! leading-[24px] text-black">
        or copy and paste this URL into your browser:{" "}
        <Link href={link} className="break-all text-blue-600 no-underline">
          {link}
        </Link>
      </Text>
    </>
  );
}

function Content(props: ResolutionNoticeEmailProps) {
  const firstName = props.recipientName?.trim().split(/\s+/)[0] || "there";
  const hello = <Text className={P}>Hello {firstName},</Text>;

  if (props.variant === "PO_COPY") {
    return (
      <>
        {hello}
        <Text className={P}>
          Under Section 6.16(i) of the Operating Agreement, a copy of the
          Manager&apos;s written resolution for the following purchase order is
          attached.
        </Text>
        <Matter {...props} />
        <Text className={P}>Vendor: {props.vendor}</Text>
        <Text className={P}>Equipment: {props.equipment}</Text>
        <Text className={P}>
          Price: {props.currency} {props.price}
        </Text>
        <Text className={P}>
          Signed on {props.effectiveAt} by {props.approverName},{" "}
          {props.approverCapacity}.
        </Text>
        <Text className={P}>No action is required.</Text>
      </>
    );
  }

  return (
    <>
      {props.variant === "RESULT" && hello}
      <Text className={P}>{props.sentence}</Text>
      {props.withdrawnReason && (
        <Text className={P}>Reason: {props.withdrawnReason}</Text>
      )}
      <Matter {...props} />
      {props.tallyLines.map((line) => (
        <Text key={line} className={P}>
          {line}
        </Text>
      ))}
      {props.variant === "RESULT" && props.status === "EFFECTIVE" && (
        <Text className={P}>
          The executed written consent is attached and has been filed with the
          books and records of the LLC.
        </Text>
      )}
      {props.variant === "RESULT" && props.link && (
        <LinkBlock
          link={props.link}
          label="View the resolution and your response"
        />
      )}
      {props.variant === "MANAGER" && (
        <LinkBlock link={props.link} label="Open the resolution" />
      )}
    </>
  );
}

export const ResolutionNoticeEmail = (props: ResolutionNoticeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{`${props.companyName}: ${props.title}`}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[465px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-black">
              {props.companyName} - <strong>{props.title}</strong>
            </Heading>
            <Content {...props} />
            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-xs text-gray-400!">
              {noticeFooter(props.companyName)}
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

ResolutionNoticeEmail.PreviewProps = {
  variant: "RESULT",
  status: "EFFECTIVE",
  companyName: "Example Compute LLC",
  recipientName: "Will Smith",
  title: "Amendment of Section 5.6",
  referenceCode: "R-2026-002",
  sentence:
    "The matter below was approved and became effective on November 20, 2026 3:12 PM MST.",
  withdrawnReason: null,
  tallyLines: [
    "Preferred Supermajority: 8,000 of 10,500 units in favour (76.19%); required: more than 66 2/3% of the Outstanding Preferred Units.",
  ],
  link: "https://captable.inc/ballots/...",
} as ResolutionNoticeEmailProps;

export default ResolutionNoticeEmail;
