import { describe, expect, it } from "vitest";
import { filterSignerValues, type SignerField } from "./filter-signer-values";

function field(overrides: Partial<SignerField> & { id: string }): SignerField {
  return {
    name: overrides.id,
    recipientId: "R1",
    readOnly: false,
    required: false,
    type: "TEXT",
    defaultValue: "",
    prefilledValue: null,
    ...overrides,
  };
}

describe("filterSignerValues", () => {
  it("keeps only the signer's own fields", () => {
    const fields = [
      field({ id: "F1", recipientId: "R1" }),
      field({ id: "F2", recipientId: "R2" }),
    ];
    const result = filterSignerValues(fields, "R1", { F1: "a", F2: "b" });
    expect(result.values).toEqual({ F1: "a" });
    expect(result.missingRequired).toEqual([]);
  });

  it("ignores a submitted value for a read-only field", () => {
    const fields = [field({ id: "F1", readOnly: true, defaultValue: "X" })];
    const result = filterSignerValues(fields, "R1", { F1: "Y" });
    expect(result.values).toEqual({ F1: "X" });
  });

  it("prefers the prefilled value of a read-only field over its default", () => {
    const fields = [
      field({
        id: "F1",
        readOnly: true,
        defaultValue: "X",
        prefilledValue: "P",
      }),
    ];
    const result = filterSignerValues(fields, "R1", { F1: "Y" });
    expect(result.values).toEqual({ F1: "P" });
  });

  it("reports a required field submitted as blanks", () => {
    const fields = [field({ id: "F1", name: "Legal name", required: true })];
    const result = filterSignerValues(fields, "R1", { F1: "  " });
    expect(result.missingRequired).toEqual(["Legal name"]);
    expect(result.values).toEqual({});
  });

  it("reports a required field that is absent", () => {
    const fields = [field({ id: "F1", name: "Legal name", required: true })];
    expect(filterSignerValues(fields, "R1", {}).missingRequired).toEqual([
      "Legal name",
    ]);
  });

  it("does not report a required read-only field", () => {
    const fields = [field({ id: "F1", required: true, readOnly: true })];
    expect(filterSignerValues(fields, "R1", {}).missingRequired).toEqual([]);
  });

  it("drops unknown keys", () => {
    const fields = [field({ id: "F1" })];
    const result = filterSignerValues(fields, "R1", {
      F1: "a",
      nope: "b",
      __proto__x: "c",
    });
    expect(result.values).toEqual({ F1: "a" });
  });

  it("trims TEXT values", () => {
    const fields = [field({ id: "F1", type: "TEXT" })];
    expect(filterSignerValues(fields, "R1", { F1: " Jane " }).values).toEqual({
      F1: "Jane",
    });
  });

  it("does not trim SIGNATURE values", () => {
    const fields = [field({ id: "F1", type: "SIGNATURE" })];
    expect(
      filterSignerValues(fields, "R1", { F1: " data:image/png " }).values,
    ).toEqual({ F1: " data:image/png " });
  });

  it("falls back to the prefilled value, then the default, when empty", () => {
    const fields = [
      field({ id: "F1", prefilledValue: "P", defaultValue: "D" }),
      field({ id: "F2", defaultValue: "D" }),
    ];
    expect(filterSignerValues(fields, "R1", { F1: "" }).values).toEqual({
      F1: "P",
      F2: "D",
    });
  });
});
