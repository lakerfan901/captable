import { describe, expect, it } from "vitest";
import {
  centsText,
  figureLabel,
  ReconciliationRefusal,
  reconciliationErrorData,
  reconciliationMessage,
} from "./reconcile-refusal";

describe("figureLabel", () => {
  it("names scalar figures and keyed lines", () => {
    expect(figureLabel("revenue.amountCents")).toBe("Gross Revenue");
    expect(figureLabel("expenses.lines[COLOCATION]")).toBe(
      "Expenses: COLOCATION",
    );
    expect(figureLabel("something.else")).toBe("something.else");
  });
});

describe("centsText", () => {
  it("formats cents as dollars", () => {
    expect(centsText(0)).toBe("$0.00");
    expect(centsText(5)).toBe("$0.05");
    expect(centsText(123_456_789)).toBe("$1,234,567.89");
    expect(centsText(-500)).toBe("-$5.00");
    expect(centsText(null)).toBe("none");
  });
});

describe("reconciliationMessage", () => {
  it("names every figure with both values", () => {
    const m = reconciliationMessage([
      {
        field: "revenue.amountCents",
        reportCents: 100_001,
        ledgerCents: 100_000,
      },
    ]);
    expect(m).toContain("Gross Revenue (report $1,000.01, ledger $1,000.00)");
    expect(m).toMatch(/Refresh the figures from the ledger/);
  });
  it("lists five and counts the rest", () => {
    const diffs = Array.from({ length: 7 }, (_, i) => ({
      field: `expenses.lines[C${i}]`,
      reportCents: i,
      ledgerCents: null,
    }));
    const m = reconciliationMessage(diffs);
    expect(m).toContain("Expenses: C4");
    expect(m).not.toContain("Expenses: C5");
    expect(m).toContain("and 2 more");
  });
});

describe("ReconciliationRefusal", () => {
  it("carries a copy of the differences and the message", () => {
    const diffs = [
      { field: "reserves.balanceCents", reportCents: 1, ledgerCents: 2 },
    ];
    const r = new ReconciliationRefusal(diffs);
    (diffs[0] as { reportCents: number }).reportCents = 99;
    expect(r.differences).toEqual([
      { field: "reserves.balanceCents", reportCents: 1, ledgerCents: 2 },
    ]);
    expect(r.message).toContain("Reserve balance");
    expect(reconciliationErrorData(r)).toEqual({
      differences: [
        { field: "reserves.balanceCents", reportCents: 1, ledgerCents: 2 },
      ],
    });
  });
  it("gives null for any other cause", () => {
    expect(reconciliationErrorData(new Error("x"))).toBeNull();
    expect(reconciliationErrorData(undefined)).toBeNull();
  });
});
