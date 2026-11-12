import { describe, expect, test } from "vitest";
import { normalizeRecipients } from "./email-recipients";

describe("normalizeRecipients", () => {
  test("lower-cases a single address", () => {
    expect(normalizeRecipients("A@x.com")).toBe("a@x.com");
  });

  test("flattens an array of strings and address objects", () => {
    expect(
      normalizeRecipients(["A@x.com", { name: "B", address: "b@Y.com" }]),
    ).toBe("a@x.com, b@y.com");
  });

  test("extracts the address from a display-name string", () => {
    expect(normalizeRecipients('"Jane" <Jane@x.com>')).toBe("jane@x.com");
  });
});
