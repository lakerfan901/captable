import { render } from "react-email";
import { describe, expect, it } from "vitest";
import {
  DistributionNoticeEmail,
  distributionNoticeSubject,
} from "./DistributionNoticeEmail";

const base = DistributionNoticeEmail.PreviewProps;

const plain = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("DistributionNoticeEmail", () => {
  it("subject", () => {
    expect(distributionNoticeSubject(base)).toBe(
      "Octagon GPU I LLC – Distribution No. 1 – $4,441.08 payable Friday, May 14, 2027",
    );
  });

  it("operating: Section 5.6 sentence, tax row shown, default row omitted", async () => {
    const t = plain(await render(DistributionNoticeEmail(base)));
    expect(t).toContain(
      "The Manager has made the following distribution under Section 5.6 of the Operating Agreement for the quarter ended March 31, 2027.",
    );
    expect(t).toContain("less tax paid on your behalf §9.2");
    expect(t).not.toContain("§4.9(iii)");
    expect(t).toContain(
      "After this distribution: Unreturned Capital Contributions $250,000.00; accrued and unpaid Preferred Return $2,483.58; Preferred Units 250.",
    );
    expect(t).toContain(
      "Reserve balance held by the LLC: $50,000.00 (Section 5.6(a)).",
    );
    expect(t).toContain("The quarterly report follows separately.");
  });

  it("return of unused capital replaces the Section 5.6 sentence", async () => {
    const t = plain(
      await render(
        DistributionNoticeEmail({ ...base, isReturnOfUnusedCapital: true }),
      ),
    );
    expect(t).toContain(
      "This is a return of Capital Contributions not required by the LLC (Section 1.15).",
    );
    expect(t).not.toContain("under Section 5.6 of the Operating Agreement");
  });
});
