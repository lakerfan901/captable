import { describe, expect, it } from "vitest";
import {
  canonicalOptionsFor,
  missingSubscriptionKeys,
  REQUIRED_SUBSCRIPTION_KEYS,
  SUBSCRIPTION_FIELD_KEYS,
} from "./subscription-fields";

describe("subscription field keys", () => {
  it("keys are unique", () => {
    const keys = SUBSCRIPTION_FIELD_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(19);
  });

  it("every key except signer_name_title is required on the master", () => {
    expect(REQUIRED_SUBSCRIPTION_KEYS).toHaveLength(18);
    expect(REQUIRED_SUBSCRIPTION_KEYS).not.toContain("signer_name_title");
    expect(REQUIRED_SUBSCRIPTION_KEYS).toContain("contribution_received");
    expect(REQUIRED_SUBSCRIPTION_KEYS).toContain("units_issued");
  });

  it("missingSubscriptionKeys([]) returns all 18 required keys", () => {
    expect(missingSubscriptionKeys([])).toEqual([
      ...REQUIRED_SUBSCRIPTION_KEYS,
    ]);
    expect(missingSubscriptionKeys([])).toHaveLength(18);
  });

  it("a master with every key on the right role is complete", () => {
    const fields: { semanticKey: string | null; role: string | null }[] =
      SUBSCRIPTION_FIELD_KEYS.map((k) => ({
        semanticKey: k.key,
        role: k.role,
      }));
    // Duplicates and unkeyed fields are allowed.
    fields.push({ semanticKey: "email", role: "investor" });
    fields.push({ semanticKey: null, role: "investor" });
    expect(missingSubscriptionKeys(fields)).toEqual([]);
  });

  it("manager_signature placed on an investor field still counts as missing", () => {
    const fields = SUBSCRIPTION_FIELD_KEYS.map((k) => ({
      semanticKey: k.key,
      role: k.key === "manager_signature" ? "investor" : k.role,
    }));
    expect(missingSubscriptionKeys(fields)).toEqual(["manager_signature"]);
  });

  it("canonical options use the enum names as ids", () => {
    expect(
      canonicalOptionsFor("accreditation_basis")?.map((o) => o.id),
    ).toEqual([
      "NET_WORTH",
      "INCOME",
      "LICENSE",
      "ENTITY_ASSETS",
      "ENTITY_ALL_OWNERS_ACCREDITED",
      "TRUST_ASSETS",
    ]);
    expect(canonicalOptionsFor("holder_type")).toEqual([
      { id: "INDIVIDUAL", value: "Individual" },
      { id: "JOINT", value: "Joint" },
      { id: "TRUST", value: "Trust" },
      { id: "ENTITY", value: "Entity" },
    ]);
    expect(canonicalOptionsFor("legal_name")).toBeUndefined();
    expect(canonicalOptionsFor("unknown")).toBeUndefined();
  });
});
