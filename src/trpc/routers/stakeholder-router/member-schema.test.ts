import { describe, expect, it } from "vitest";
import { ZMemberInput } from "./member-schema";

const base = {
  name: "Jane Doe",
  email: "jane@example.com",
  holderType: "INDIVIDUAL" as const,
  isInsider: false,
};

describe("ZMemberInput", () => {
  it("lower-cases and trims the email", () => {
    const r = ZMemberInput.parse({ ...base, email: "  Jane@Example.COM " });
    expect(r.email).toBe("jane@example.com");
  });

  it("requires signerName for an entity", () => {
    expect(
      ZMemberInput.safeParse({ ...base, holderType: "ENTITY" }).success,
    ).toBe(false);
    expect(
      ZMemberInput.safeParse({
        ...base,
        holderType: "ENTITY",
        signerName: "John Roe",
      }).success,
    ).toBe(true);
  });

  it("accepts only 2-letter state codes for residenceState", () => {
    expect(
      ZMemberInput.safeParse({ ...base, residenceState: "Kentucky" }).success,
    ).toBe(false);
    expect(
      ZMemberInput.safeParse({ ...base, residenceState: "KY" }).success,
    ).toBe(true);
  });
});
