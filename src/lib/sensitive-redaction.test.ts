import { describe, expect, it } from "vitest";
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
} from "../constants/sentry-scrub";
import {
  isSensitiveKey,
  REDACTED_FIELD,
  redactSensitive,
  redactSensitiveText,
} from "./sensitive-redaction";

const ACCOUNT = "000123456789";
const ROUTING = "021000021";

describe("isSensitiveKey", () => {
  it.each([
    "accountNumber",
    "account_number",
    "routingNumber",
    "swiftCode",
    "iban",
    "password",
    "newPassword",
    "passwd",
    "clientSecret",
    "token",
    "accessToken",
    "refresh_token",
    "apiKey",
    "api_key",
    "authorization",
    "cookie",
    "ssn",
  ])("%s is sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "typedName",
    "signedName",
    "name",
    "email",
    "bankName",
    "amountCents",
    "beneficiaryName",
  ])("%s is not", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactSensitive", () => {
  it("redacts the bank-account create input recursively, keeps the rest", () => {
    const input = {
      beneficiaryName: "Acme LLC",
      bankName: "Test Bank",
      accountNumber: ACCOUNT,
      routingNumber: ROUTING,
      swiftCode: "CHASUS33",
      nested: { list: [{ password: "hunter2", typedName: "Jane Doe" }] },
    };
    const out = redactSensitive(input);
    expect(out).toEqual({
      beneficiaryName: "Acme LLC",
      bankName: "Test Bank",
      accountNumber: REDACTED_FIELD,
      routingNumber: REDACTED_FIELD,
      swiftCode: REDACTED_FIELD,
      nested: {
        list: [{ password: REDACTED_FIELD, typedName: "Jane Doe" }],
      },
    });
    // Never mutates its argument.
    expect(input.accountNumber).toBe(ACCOUNT);
  });

  it("redacts a whole object or number under a sensitive key", () => {
    expect(
      redactSensitive({ secret: { a: 1 }, accountNumber: 123456789 }),
    ).toEqual({ secret: REDACTED_FIELD, accountNumber: REDACTED_FIELD });
  });

  it("redacts [key, value] query pairs", () => {
    expect(
      redactSensitive([
        ["accountNumber", ACCOUNT],
        ["page", "2"],
      ]),
    ).toEqual([
      ["accountNumber", REDACTED_FIELD],
      ["page", "2"],
    ]);
  });

  it("keeps non-plain objects and handles cycles", () => {
    const a: Record<string, unknown> = { routingNumber: ROUTING };
    a.self = a;
    const out = redactSensitive(a) as Record<string, unknown>;
    expect(out.routingNumber).toBe(REDACTED_FIELD);
    const d = new Date(0);
    expect(redactSensitive({ d }).d).toBe(d);
    expect(redactSensitive(12n)).toBe(12n);
  });
});

describe("redactSensitiveText", () => {
  it("redacts JSON, escaped JSON and key=value pairs", () => {
    const json = JSON.stringify({ accountNumber: ACCOUNT, bankName: "B" });
    expect(redactSensitiveText(json)).toBe(
      `{"accountNumber":"${REDACTED_FIELD}","bankName":"B"}`,
    );
    const escaped = JSON.stringify({ body: json });
    expect(redactSensitiveText(escaped)).not.toContain(ACCOUNT);
    expect(redactSensitiveText(`{"routingNumber": 21000021}`)).not.toContain(
      "21000021",
    );
    expect(
      redactSensitiveText(`a=1&accountNumber=${ACCOUNT}&password=x y`),
    ).toBe(`a=1&accountNumber=${REDACTED_FIELD}&password=${REDACTED_FIELD} y`);
    expect(redactSensitiveText("nothing to see")).toBe("nothing to see");
  });
});

describe("Sentry hooks (defence in depth)", () => {
  it("an error event carrying tRPC input loses the account numbers", () => {
    const event = {
      contexts: {
        trpc: {
          procedure_path: "bankAccounts.create",
          input: { accountNumber: ACCOUNT, routingNumber: ROUTING },
        },
      },
      request: { data: JSON.stringify({ json: { accountNumber: ACCOUNT } }) },
      exception: {
        values: [{ value: `Unique constraint on accountNumber=${ACCOUNT}` }],
      },
    };
    const out = JSON.stringify(
      // biome-ignore lint/suspicious/noExplicitAny: test double
      scrubEvent(event as any, {}),
    );
    expect(out).not.toContain(ACCOUNT);
    expect(out).not.toContain(ROUTING);
    expect(out).toContain("bankAccounts.create");
  });

  it("breadcrumbs and span attributes too", () => {
    const crumb = scrubBreadcrumb(
      { category: "fetch", data: { body: { password: "hunter2" } } },
      undefined,
    );
    expect(JSON.stringify(crumb)).not.toContain("hunter2");
    const span = scrubSpan({
      name: "POST /api/trpc/bankAccounts.create",
      attributes: { "rpc.input": `{"accountNumber":"${ACCOUNT}"}` },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any);
    expect(JSON.stringify(span)).not.toContain(ACCOUNT);
  });
});
