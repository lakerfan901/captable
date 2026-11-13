import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "react-email";
import { describe, expect, it } from "vitest";
import { OA_DEFAULTS } from "../../lib/llc/config";
import { noticeTermsText } from "../../server/llc/economics/call-notices.logic";
import { CallNoticeEmail, type CallNoticeEmailProps } from "./CallNoticeEmail";

// The fixtures were rendered from the template as it was before its text
// became settings-aware (hard-coded "three business days", 12%, five business
// days, 50%, $1,000 and the later-of accrual sentence).
const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", name), "utf8");

const base = CallNoticeEmail.PreviewProps;

function propsFor(
  overrides: Partial<Parameters<typeof noticeTermsText>[0]>,
): CallNoticeEmailProps {
  return {
    ...base,
    ...noticeTermsText({
      callNoticeBusinessDays: OA_DEFAULTS.callNoticeBusinessDays,
      balanceReturnStartRule: OA_DEFAULTS.balanceReturnStartRule,
      defaultInterestBps: OA_DEFAULTS.defaultInterestBps,
      forfeitureCureBusinessDays: OA_DEFAULTS.forfeitureCureBusinessDays,
      forfeitureBps: OA_DEFAULTS.forfeitureBps,
      pricePerUnitCents: OA_DEFAULTS.pricePerUnitCents,
      ...overrides,
    }),
  };
}

const plain = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("CallNoticeEmail text follows the settings", () => {
  it("under the Operating Agreement defaults renders byte-for-byte as before", async () => {
    expect(await render(CallNoticeEmail(propsFor({})))).toBe(
      fixture("call-notice-default.golden"),
    );
    expect(
      await render(CallNoticeEmail({ ...propsFor({}), isOutsideDate: true })),
    ).toBe(fixture("call-notice-outside-date.golden"));
  });

  it("PreviewProps carry the default terms", () => {
    const terms = noticeTermsText({
      ...OA_DEFAULTS,
    });
    for (const [k, v] of Object.entries(terms)) {
      expect(base[k as keyof CallNoticeEmailProps]).toBe(v);
    }
  });

  it("RECEIPT_DATE: the return accrues from the date of receipt", async () => {
    const text = plain(
      await render(
        CallNoticeEmail(propsFor({ balanceReturnStartRule: "RECEIPT_DATE" })),
      ),
    );
    expect(text).toContain(
      "The Preferred Return on this amount accrues from the date of receipt.",
    );
    expect(text).not.toContain("the later of the due date");
  });

  it("10 business days notice and other configured figures", async () => {
    const text = plain(
      await render(
        CallNoticeEmail(
          propsFor({
            callNoticeBusinessDays: 10,
            forfeitureCureBusinessDays: 7,
            defaultInterestBps: 1000,
            forfeitureBps: 2500,
            pricePerUnitCents: 50_000n,
          }),
        ),
      ),
    );
    expect(text).toContain(
      "(ten business days after this notice, and in any event not later than March 31, 2027)",
    );
    expect(text).not.toContain("three business days");
    expect(text).toContain("interest at 10% per annum");
    expect(text).toContain("if not cured within seven business days");
    expect(text).toContain("forfeiture of 25% of the unpaid Balance");
    expect(text).toContain("one Unit per $500 when");
    expect(text).not.toContain("12%");
    expect(text).not.toContain("five business days");
  });
});
