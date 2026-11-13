import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { describe, expect, it } from "vitest";
import { buildFrom, cleanDisplayName, senderAddress } from "./mail-from";

/** Builds the real message nodemailer would send and returns its From header value. */
async function fromHeader(from: { name: string; address: string }) {
  const raw = await new MailComposer({
    from,
    to: "member@example.com",
    subject: "x",
    text: "x",
  })
    .compile()
    .build();
  const head = raw.toString("utf8").split("\r\n\r\n")[0] ?? "";
  // Unfold continuation lines, then take the From header.
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  const line = unfolded.split("\r\n").find((l) => /^From:/i.test(l)) ?? "";
  return { line, value: line.replace(/^From:\s*/i, ""), head: unfolded };
}

const HOSTILE = [
  "Octagon GPU <ceo@octagon-gpu.example>",
  'Evil "Quoted" <x@evil.example>, other@evil.example',
  "zz A 2026-11-13T09:01:28.468Z",
  "Group: a@evil.example, b@evil.example;",
  "Name\r\nBcc: victim@evil.example",
  "Line\nbreak\rand\ttab",
  "<script>@evil.example",
];

describe("buildFrom", () => {
  it("always uses the address of EMAIL_FROM", () => {
    for (const name of HOSTILE) {
      expect(buildFrom(name, "noreply@example.com").address).toBe(
        "noreply@example.com",
      );
    }
  });

  it("accepts EMAIL_FROM with a display name", () => {
    expect(senderAddress("'Captable, Inc.' <support@captable.inc>")).toEqual({
      name: "'Captable, Inc.'",
      address: "support@captable.inc",
    });
    expect(buildFrom(undefined, "Acme <noreply@example.com>")).toEqual({
      name: "Acme",
      address: "noreply@example.com",
    });
    expect(buildFrom("", "noreply@example.com").name).toBe("Captable");
  });

  it("strips CR, LF and other control characters from the name", () => {
    expect(cleanDisplayName("Name\r\nBcc: victim@evil.example")).toBe(
      "Name Bcc: victim@evil.example",
    );
    expect(cleanDisplayName("Line\nbreak\rand\ttab")).toBe(
      "Line break and tab",
    );
    expect(cleanDisplayName("x".repeat(300))).toHaveLength(100);
  });

  it.each(HOSTILE)(
    "a company name cannot change the sender or add a header: %s",
    async (name) => {
      const from = buildFrom(name, "noreply@example.com");
      const { value, head } = await fromHeader(from);
      const parsed = addressparser(value, { flatten: true });
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.address).toBe("noreply@example.com");
      // No header was injected through the name.
      expect(head).not.toMatch(/^Bcc:/im);
      expect(head.match(/^From:/gim)).toHaveLength(1);
    },
  );
});
