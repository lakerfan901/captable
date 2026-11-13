import { describe, expect, it } from "vitest";
import {
  MAIL_BLOCKED_MESSAGE,
  mailBlockedReason,
  mailDeliveryState,
} from "./mail-delivery";

describe("mail delivery rule (reports, resolutions, notices)", () => {
  it("refuses only in production with the mail catcher", () => {
    expect(
      mailBlockedReason({ nodeEnv: "production", mailCatcher: true }, "REPORT"),
    ).toBe(MAIL_BLOCKED_MESSAGE.REPORT);
    expect(
      mailBlockedReason(
        { nodeEnv: "production", mailCatcher: true },
        "RESOLUTION",
      ),
    ).toBe(MAIL_BLOCKED_MESSAGE.RESOLUTION);
    expect(
      mailBlockedReason(
        { nodeEnv: "production", mailCatcher: false },
        "REPORT",
      ),
    ).toBeNull();
    expect(
      mailBlockedReason(
        { nodeEnv: "development", mailCatcher: true },
        "REPORT",
      ),
    ).toBeNull();
    expect(
      mailBlockedReason({ nodeEnv: undefined, mailCatcher: true }, "REPORT"),
    ).toBeNull();
  });

  it("says what sending would do", () => {
    expect(MAIL_BLOCKED_MESSAGE.REPORT).toMatch(/closes the books/);
    expect(MAIL_BLOCKED_MESSAGE.RESOLUTION).toMatch(
      /freezes the voting register and starts the response deadline/,
    );
  });

  it("is in test mode whenever the catcher is configured", () => {
    expect(
      mailDeliveryState(
        { nodeEnv: "development", mailCatcher: true },
        "MEMBER_EMAIL",
      ),
    ).toEqual({ testMode: true, blockedReason: null });
    expect(
      mailDeliveryState(
        { nodeEnv: "production", mailCatcher: false },
        "MEMBER_EMAIL",
      ),
    ).toEqual({ testMode: false, blockedReason: null });
  });
});
