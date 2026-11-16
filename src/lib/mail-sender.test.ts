import { describe, expect, it } from "vitest";
import { isTransactionalKind, senderAddressFor } from "./mail-sender";

const both = { investor: "investors@x.test", transactional: "notify@x.test" };

describe("mail sender", () => {
  it("account and system kinds are transactional", () => {
    for (const kind of [
      "auth.password-reset",
      "auth.verify-email",
      "team.invite",
      "portal.invite",
      "portal.password-reset",
      "portal.documents-shared",
    ]) {
      expect(isTransactionalKind(kind)).toBe(true);
      expect(senderAddressFor(kind, both)).toBe("notify@x.test");
    }
  });

  it("member-facing company emails use the investor address", () => {
    for (const kind of [
      "governance.report",
      "llc.call-notice",
      "llc.distribution-notice",
      "resolution.ballot",
      "esign.request",
      "exhibit-b",
      "uncategorized",
      undefined,
      null,
    ]) {
      expect(senderAddressFor(kind, both)).toBe("investors@x.test");
    }
  });

  it("falls back to the investor address when none is configured", () => {
    for (const transactional of [undefined, null, "", "  "]) {
      expect(
        senderAddressFor("auth.password-reset", {
          investor: "investors@x.test",
          transactional,
        }),
      ).toBe("investors@x.test");
    }
  });
});
