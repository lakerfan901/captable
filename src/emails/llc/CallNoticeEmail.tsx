import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from "react-email";

/** Every value is preformatted by the server (dates, dollars). */
export interface CallNoticeEmailProps {
  companyName: string;
  memberName: string;
  noticeNumber: string;
  sentOnLong: string;
  dueOnLong: string;
  /** The Balance outside date (Section 4.9) from the unit class, e.g. "March 31, 2027". */
  outsideDateLong: string;
  amountCalled: string;
  alreadyReceived: string;
  amountDue: string;
  committed: string;
  paidToDate: string;
  remainingAfter: string;
  purpose: string;
  wire: {
    beneficiaryName: string;
    beneficiaryAddress: string;
    bankName: string;
    bankAddress: string;
    routingNumber: string;
    accountNumber: string;
    swiftCode: string;
  };
  reference: string;
  managerName: string;
  managerEmail: string;
  isOutsideDate: boolean;
}

const text = "text-[14px] leading-[24px] text-black";

function AmountRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <Row>
      <Column className="py-[4px] text-[14px] text-black">
        {strong ? <strong>{label}</strong> : label}
      </Column>
      <Column className="py-[4px] text-right text-[14px] text-black">
        {strong ? <strong>{value}</strong> : value}
      </Column>
    </Row>
  );
}

function WireRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column className="w-[45%] py-[2px] text-[13px] text-neutral-600">
        {label}
      </Column>
      <Column className="py-[2px] text-[13px] text-black">{value}</Column>
    </Row>
  );
}

export const CallNoticeEmail = ({
  companyName,
  memberName,
  noticeNumber,
  sentOnLong,
  dueOnLong,
  outsideDateLong,
  amountCalled,
  alreadyReceived,
  amountDue,
  committed,
  paidToDate,
  remainingAfter,
  purpose,
  wire,
  reference,
  managerName,
  managerEmail,
  isOutsideDate,
}: CallNoticeEmailProps) => {
  const previewText = `Call Notice No. ${noticeNumber}: ${amountDue} due ${dueOnLong}`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[560px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 my-[24px] p-0 text-center text-[22px] font-normal text-black">
              {companyName} — <strong>Call Notice No. {noticeNumber}</strong>
            </Heading>
            <Text className="text-[13px] leading-[20px] text-neutral-600">
              {sentOnLong}
            </Text>

            <Text className={text}>Dear {memberName},</Text>
            <Text className={text}>
              This is a Call Notice under Section 4.9 of the Operating Agreement
              of {companyName}. The Manager has determined that the following
              part of the Balance of your Capital Contribution is needed.
              {purpose ? ` ${purpose}` : ""}
            </Text>

            <Section className="my-[16px]">
              <AmountRow
                label="Capital Contribution committed"
                value={committed}
              />
              <AmountRow label="Paid to date" value={paidToDate} />
              <AmountRow
                label="Amount called by this notice"
                value={amountCalled}
                strong
              />
              <AmountRow
                label="Already received toward this call"
                value={alreadyReceived}
              />
              <AmountRow label="Amount due" value={amountDue} strong />
              <AmountRow
                label="Remaining Balance after this call"
                value={remainingAfter}
              />
            </Section>

            {isOutsideDate ? (
              <Text className={text}>
                <strong>Payment is due by {dueOnLong}</strong> (the Balance is
                due not later than {outsideDateLong} whether or not a Call
                Notice has been given).
              </Text>
            ) : (
              <Text className={text}>
                <strong>Payment is due by {dueOnLong}</strong> (three business
                days after this notice, and in any event not later than{" "}
                {outsideDateLong}).
              </Text>
            )}

            <Section className="my-[16px] rounded border border-solid border-neutral-200 p-[12px]">
              <Text className="m-0 mb-[8px] text-[14px] font-semibold text-black">
                Wire instructions
              </Text>
              <WireRow label="Beneficiary" value={wire.beneficiaryName} />
              <WireRow
                label="Beneficiary address"
                value={wire.beneficiaryAddress}
              />
              <WireRow label="Bank" value={wire.bankName} />
              <WireRow label="Bank address" value={wire.bankAddress} />
              <WireRow
                label="Routing number (ABA)"
                value={wire.routingNumber}
              />
              <WireRow label="Account number" value={wire.accountNumber} />
              {wire.swiftCode ? (
                <WireRow label="SWIFT code" value={wire.swiftCode} />
              ) : null}
              <WireRow label="Reference" value={reference} />
            </Section>

            <Text className={text}>
              <strong>
                Wire instructions will not be changed by email. Before sending
                funds, confirm these details with the Manager by telephone at a
                number you already have.
              </strong>
            </Text>
            <Text className={text}>
              Preferred Units are issued at one Unit per $1,000 when your
              payment is received. The Preferred Return on this amount accrues
              from the later of the due date and the date of receipt.
            </Text>
            <Text className={text}>
              If the amount due is not received in full by the due date, Section
              4.9 of the Operating Agreement applies, including interest at 12%
              per annum from the due date, suspension of voting rights and
              distributions while the default continues, and, if not cured
              within five business days after the due date, forfeiture of 50% of
              the unpaid Balance (up to the amount you have paid).
            </Text>
            <Text className={text}>
              Questions: {managerName}, {managerEmail}.
            </Text>

            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-center text-[12px] text-neutral-500">
              {companyName}
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

CallNoticeEmail.PreviewProps = {
  companyName: "Octagon GPU I LLC",
  memberName: "Jane Doe",
  noticeNumber: "1",
  sentOnLong: "Thursday, January 14, 2027",
  dueOnLong: "Wednesday, January 20, 2027",
  outsideDateLong: "March 31, 2027",
  amountCalled: "$30,000.00",
  alreadyReceived: "$20,000.00",
  amountDue: "$10,000.00",
  committed: "$100,000.00",
  paidToDate: "$60,000.00",
  remainingAfter: "$30,000.00",
  purpose: "The amount will pay for the LLC's servers.",
  wire: {
    beneficiaryName: "Octagon GPU I LLC",
    beneficiaryAddress: "1 Main Street, Cheyenne, WY 82001",
    bankName: "First Bank",
    bankAddress: "2 Bank Street, Denver, CO 80202",
    routingNumber: "123456789",
    accountNumber: "•••• 6789",
    swiftCode: "",
  },
  reference: "Octagon GPU I LLC CN1 Jane Doe",
  managerName: "Karl Example",
  managerEmail: "manager@example.com",
  isOutsideDate: false,
} as CallNoticeEmailProps;

export default CallNoticeEmail;
