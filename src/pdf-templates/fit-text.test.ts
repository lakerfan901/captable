import { describe, expect, it } from "vitest";
import { fitCell, noHyphenation, textWidth } from "./fit-text";

// The Exhibit A notice column: 29% of 732pt less 6pt of padding.
const NOTICE = 0.29 * 732 - 6;

describe("noHyphenation", () => {
  it("never splits a word", () => {
    expect(noHyphenation("priya.prospect@example.com")).toEqual([
      "priya.prospect@example.com",
    ]);
    expect(noHyphenation("Anticonstitutionnellement")).toEqual([
      "Anticonstitutionnellement",
    ]);
  });
});

describe("fitCell", () => {
  it("keeps the base size when every word fits", () => {
    const text = "1 Main St, Cheyenne, WY 82001\npriya.prospect@example.com";
    expect(fitCell(text, NOTICE, 8, 5)).toEqual({ fontSize: 8, text });
  });

  it("shrinks a cell whose email is too long for the column, text unchanged", () => {
    const email =
      "priya.prospect.long.address.for.notices@subsidiary.example.com";
    expect(textWidth(email, 8)).toBeGreaterThan(NOTICE);
    const fit = fitCell(`1 Main St\n${email}`, NOTICE, 8, 5);
    expect(fit.fontSize).toBeLessThan(8);
    expect(fit.fontSize).toBeGreaterThanOrEqual(5);
    expect(textWidth(email, fit.fontSize)).toBeLessThanOrEqual(NOTICE);
    expect(fit.text).toBe(`1 Main St\n${email}`);
  });

  it("below the minimum size splits the word over lines without adding a character", () => {
    const email = `${"a".repeat(60)}.${"b".repeat(30)}@example.com`;
    const fit = fitCell(email, NOTICE, 8, 5);
    expect(fit.fontSize).toBe(5);
    const lines = fit.text.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(email);
    expect(fit.text).not.toContain("-");
    for (const line of lines) {
      expect(textWidth(line, 5)).toBeLessThanOrEqual(NOTICE);
    }
    // the break falls after the "." or "@" where it can
    expect(lines[0]?.endsWith(".") || lines[0]?.endsWith("@")).toBe(true);
  });
});
