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

/** Every value is preformatted by the server (dates, dollars, units). */
export interface DistributionNoticeEmailProps {
  companyName: string;
  memberName: string;
  distributionNumber: string;
  /** e.g. "Operating distribution". */
  typeLabel: string;
  periodLabel: string;
  paymentDateLong: string;
  tierC: string;
  tierD: string;
  tierE: string;
  gross: string;
  /** "" when zero (the row is then omitted). */
  defaultOffset: string;
  /** "" when zero (the row is then omitted). */
  taxAdvanceOffset: string;
  net: string;
  unpaidReturnAfter: string;
  unreturnedAfter: string;
  preferredUnits: string;
  reserveBalance: string;
  managerName: string;
  managerEmail: string;
  isReturnOfUnusedCapital: boolean;
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

/** `{companyName} – Distribution No. {n} – {net} payable {paymentDateLong}`. */
export function distributionNoticeSubject(
  p: Pick<
    DistributionNoticeEmailProps,
    "companyName" | "distributionNumber" | "net" | "paymentDateLong"
  >,
): string {
  return `${p.companyName} – Distribution No. ${p.distributionNumber} – ${p.net} payable ${p.paymentDateLong}`;
}

export const DistributionNoticeEmail = (p: DistributionNoticeEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{distributionNoticeSubject(p)}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[560px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 my-[24px] p-0 text-center text-[22px] font-normal text-black">
              {p.companyName} —{" "}
              <strong>Distribution No. {p.distributionNumber}</strong>
            </Heading>
            <Text className="text-[13px] leading-[20px] text-neutral-600">
              {p.typeLabel} · payment date {p.paymentDateLong}
            </Text>

            <Text className={text}>Dear {p.memberName},</Text>
            <Text className={text}>
              {p.isReturnOfUnusedCapital
                ? "This is a return of Capital Contributions not required by the LLC (Section 1.15). It reduces your Unreturned Capital Contributions and is not a payment of Preferred Return."
                : `The Manager has made the following distribution under Section 5.6 of the Operating Agreement for ${p.periodLabel}.`}
            </Text>

            <Section className="my-[16px]">
              <AmountRow label="Preferred Return §5.6(c)" value={p.tierC} />
              <AmountRow label="Return of capital §5.6(d)" value={p.tierD} />
              <AmountRow label="Residual §5.6(e)" value={p.tierE} />
              <AmountRow label="Total distribution" value={p.gross} strong />
              {p.defaultOffset ? (
                <AmountRow
                  label="less applied to unpaid Balance, interest and costs §4.9(iii)"
                  value={p.defaultOffset}
                />
              ) : null}
              {p.taxAdvanceOffset ? (
                <AmountRow
                  label="less tax paid on your behalf §9.2"
                  value={p.taxAdvanceOffset}
                />
              ) : null}
              <AmountRow label="Net amount paid to you" value={p.net} strong />
            </Section>

            <Text className={text}>
              {`After this distribution: Unreturned Capital Contributions ${p.unreturnedAfter}; accrued and unpaid Preferred Return ${p.unpaidReturnAfter}; Preferred Units ${p.preferredUnits}.`}
            </Text>
            {p.defaultOffset ? (
              <Text className={text}>
                These figures are stated before the amount applied to your
                unpaid Balance, interest and costs. Any part applied to the
                Balance is credited to you as a Capital Contribution and appears
                on your next statement.
              </Text>
            ) : null}
            <Text className={text}>
              {`Reserve balance held by the LLC: ${p.reserveBalance} (Section 5.6(a)).`}
            </Text>
            <Text className={text}>
              The quarterly report follows separately.
            </Text>
            <Text className={text}>
              Questions: {p.managerName}, {p.managerEmail}.
            </Text>

            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-center text-[12px] text-neutral-500">
              {p.companyName}
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

DistributionNoticeEmail.PreviewProps = {
  companyName: "Octagon GPU I LLC",
  memberName: "Holder B",
  distributionNumber: "1",
  typeLabel: "Operating distribution",
  periodLabel: "the quarter ended March 31, 2027",
  paymentDateLong: "Friday, May 14, 2027",
  tierC: "$6,941.08",
  tierD: "$0.00",
  tierE: "$0.00",
  gross: "$6,941.08",
  defaultOffset: "",
  taxAdvanceOffset: "$2,500.00",
  net: "$4,441.08",
  unpaidReturnAfter: "$2,483.58",
  unreturnedAfter: "$250,000.00",
  preferredUnits: "250",
  reserveBalance: "$50,000.00",
  managerName: "Karl Example",
  managerEmail: "manager@example.com",
  isReturnOfUnusedCapital: false,
} as DistributionNoticeEmailProps;

export default DistributionNoticeEmail;
