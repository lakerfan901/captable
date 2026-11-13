import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from "react-email";

// Daily compliance digest to the company's Manager users (03-governance.md
// G14, "Digest email"). Internal: never sent to Members.

export interface ComplianceDigestItem {
  /** Calendar date `YYYY-MM-DD` (a date, not an instant: no time zone). */
  dueOn: string;
  title: string;
  section: string | null;
  /** Days from the company's today to `dueOn`; negative when overdue. */
  daysLeft: number;
}

export interface ComplianceDigestEmailProps {
  companyName: string;
  recipientName: string | null | undefined;
  items: ComplianceDigestItem[];
  link: string;
}

export function complianceDigestSubject(
  companyName: string,
  count: number,
): string {
  return `${companyName}: ${count} compliance deadline${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention`;
}

const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** `Overdue by {k} day(s)` | `Due today` | `Due in {k} day(s)`. */
export function digestStatus(daysLeft: number): string {
  if (daysLeft < 0) return `Overdue by ${dayCount(-daysLeft)}`;
  if (daysLeft === 0) return "Due today";
  return `Due in ${dayCount(daysLeft)}`;
}

/** Overdue rows first; then by due date, then by title. */
export function sortDigestItems(
  items: ComplianceDigestItem[],
): ComplianceDigestItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.daysLeft < 0) - Number(a.daysLeft < 0) ||
      (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) ||
      a.title.localeCompare(b.title),
  );
}

/** "2026-11-28" → "Nov 28, 2026", read as a calendar date (UTC), never shifted by a zone. */
export function formatDueOn(dueOn: string): string {
  const date = new Date(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dueOn;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

const P = "text-[14px] leading-[24px] text-black";
const CELL = "py-[6px] pr-[8px] align-top text-[12px] leading-[18px]";

export const ComplianceDigestEmail = ({
  companyName,
  recipientName,
  items,
  link,
}: ComplianceDigestEmailProps) => {
  const firstName = recipientName?.trim().split(/\s+/)[0] || "there";
  const rows = sortDigestItems(items);
  const subject = complianceDigestSubject(companyName, rows.length);

  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Tailwind>
        <Body className="mx-auto my-auto bg-white font-sans">
          <Container className="mx-auto my-[40px] max-w-[560px] border-separate rounded border border-solid border-neutral-200 p-[20px]">
            <Heading className="mx-0 my-[30px] p-0 text-center text-[24px] font-normal text-black">
              {companyName} - <strong>Compliance deadlines</strong>
            </Heading>
            <Text className={P}>{`Hello ${firstName},`}</Text>
            <Text className={P}>
              {rows.length === 1
                ? "The following compliance deadline needs attention:"
                : "The following compliance deadlines need attention:"}
            </Text>
            <Section>
              <Row className="border-b border-solid border-neutral-200">
                <Column className={`${CELL} font-semibold`}>Due</Column>
                <Column className={`${CELL} font-semibold`}>Item</Column>
                <Column className={`${CELL} font-semibold`}>Section</Column>
                <Column className={`${CELL} font-semibold`}>Status</Column>
              </Row>
              {rows.map((item, index) => (
                <Row
                  // biome-ignore lint/suspicious/noArrayIndexKey: static email markup; two items may share a date and title
                  key={index}
                  className="border-b border-solid border-neutral-100"
                >
                  <Column className={`${CELL} whitespace-nowrap`}>
                    {formatDueOn(item.dueOn)}
                  </Column>
                  <Column className={CELL}>{item.title}</Column>
                  <Column className={CELL}>{item.section ?? "—"}</Column>
                  <Column
                    className={`${CELL} ${item.daysLeft < 0 ? "font-semibold text-red-700" : ""}`}
                  >
                    {digestStatus(item.daysLeft)}
                  </Column>
                </Row>
              ))}
            </Section>
            <Section className="mb-[32px] mt-[32px]">
              <Button
                className="rounded bg-black px-5 py-3 text-center text-[12px] font-semibold text-white no-underline"
                href={link}
              >
                Open the compliance calendar
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
            <Hr className="mx-0 my-[26px] w-full border border-solid border-neutral-200" />
            <Text className="text-xs text-gray-400!">
              You receive this because you administer {companyName}. Reminders
              are sent 30, 14, 7, 3 and 1 day(s) before a deadline, on the day,
              and weekly while overdue.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};

ComplianceDigestEmail.PreviewProps = {
  companyName: "Example Compute LLC",
  recipientName: "Will Smith",
  items: [
    {
      dueOn: "2026-11-14",
      title: "Distribute Available Cash for Q3 2026",
      section: "5.6(a)",
      daysLeft: -11,
    },
    {
      dueOn: "2026-11-28",
      title: "Every uncalled Balance is due",
      section: "4.9",
      daysLeft: 3,
    },
    {
      dueOn: "2027-02-14",
      title: "Quarterly report for Q4 2026",
      section: "8.2; 5.6(a)",
      daysLeft: 81,
    },
  ],
  link: "https://captable.inc/abc123/compliance",
} satisfies ComplianceDigestEmailProps;

export default ComplianceDigestEmail;
