import { describe, expect, it } from "vitest";
import {
  dashboardConsequence,
  differencesSentence,
  reconcileBlock,
  reconcileBlocks,
  refusalDifferences,
  reportFinancialsLines,
} from "./release-reconcile-view";

const diff = {
  field: "revenue.amountCents",
  reportCents: 1_234_500,
  ledgerCents: 1_200_000,
};

const base = {
  withFigures: true,
  answer: undefined,
  error: null,
  fetching: false,
  refusal: null,
};

describe("reconcileBlock", () => {
  it("is absent for reports without figures and for unchecked answers", () => {
    expect(reconcileBlock({ ...base, withFigures: false })).toEqual({
      kind: "none",
    });
    expect(
      reconcileBlock({ ...base, answer: { checked: false, differences: [] } }),
    ).toEqual({ kind: "none" });
  });
  it("is loading before the answer and while re-checking", () => {
    expect(reconcileBlock(base).kind).toBe("loading");
    expect(
      reconcileBlock({
        ...base,
        answer: { checked: true, differences: [] },
        fetching: true,
      }).kind,
    ).toBe("loading");
  });
  it("matches, or lists the differences with labels and amounts", () => {
    expect(
      reconcileBlock({ ...base, answer: { checked: true, differences: [] } }),
    ).toEqual({ kind: "match" });
    expect(
      reconcileBlock({
        ...base,
        answer: { checked: true, differences: [diff] },
      }),
    ).toEqual({
      kind: "differences",
      rows: [
        {
          field: "revenue.amountCents",
          label: "Gross Revenue",
          report: "$12,345.00",
          ledger: "$12,000.00",
        },
      ],
    });
  });
  it("prefers the refusal of a release over an older answer", () => {
    const b = reconcileBlock({
      ...base,
      answer: { checked: true, differences: [] },
      refusal: [
        { field: "expenses.lines[POWER]", reportCents: null, ledgerCents: 500 },
      ],
    });
    expect(b).toEqual({
      kind: "differences",
      rows: [
        {
          field: "expenses.lines[POWER]",
          label: "Expenses: POWER",
          report: "none",
          ledger: "$5.00",
        },
      ],
    });
  });
  it("shows a failed check without blocking", () => {
    const b = reconcileBlock({ ...base, error: "boom" });
    expect(b).toEqual({ kind: "error", message: "boom" });
    expect(reconcileBlocks(b)).toBeNull();
  });
  it("blocks while loading or with differences only", () => {
    expect(reconcileBlocks({ kind: "loading" })).toMatch(/Checking/);
    expect(reconcileBlocks({ kind: "differences", rows: [] })).toMatch(
      /differ from the ledger/,
    );
    expect(reconcileBlocks({ kind: "match" })).toBeNull();
    expect(reconcileBlocks({ kind: "none" })).toBeNull();
  });
});

describe("texts", () => {
  it("counts differences", () => {
    expect(differencesSentence(1)).toBe(
      "1 figure differs from the ledger for this period.",
    );
    expect(differencesSentence(2)).toBe(
      "2 figures differ from the ledger for this period.",
    );
  });
  it("adds the dashboard consequence for quarterly and annual reports only", () => {
    expect(dashboardConsequence("QUARTERLY", "2026-03-31")).toBe(
      "The financial dashboard will show figures through Mar 31, 2026 to the selected holders.",
    );
    expect(dashboardConsequence("ANNUAL", "2026-12-31")).toMatch(
      /Dec 31, 2026/,
    );
    expect(dashboardConsequence("NOTICE", "2026-03-31")).toBeNull();
    expect(dashboardConsequence("QUARTERLY", null)).toBeNull();
  });
});

describe("refusalDifferences", () => {
  it("reads error.data.reconciliation.differences", () => {
    expect(
      refusalDifferences({ data: { reconciliation: { differences: [diff] } } }),
    ).toEqual([diff]);
  });
  it("is null for other errors", () => {
    expect(refusalDifferences(new Error("x"))).toBeNull();
    expect(refusalDifferences({ data: { reconciliation: null } })).toBeNull();
    expect(refusalDifferences(null)).toBeNull();
    expect(refusalDifferences("x")).toBeNull();
  });
});

describe("reportFinancialsLines", () => {
  const view = {
    publishedThrough: "2026-06-30",
    restatements: [
      { month: "2026-02-01", at: "2026-11-15" },
      { month: "2026-03-01", at: "2026-11-15" },
      { month: "2026-05-01", at: "2026-11-20" },
    ],
  };
  it("names the published-through date and the restatements of the period", () => {
    expect(
      reportFinancialsLines(view, { start: "2026-01-01", end: "2026-03-31" }),
    ).toEqual({
      publishedThrough: "Financials published through Jun 30, 2026",
      restated:
        "Figures for this period were restated on Nov 15, 2026; the dashboard shows the restated figures.",
    });
  });
  it("has no restated note when no month of the period was restated", () => {
    expect(
      reportFinancialsLines(view, { start: "2026-07-01", end: "2026-09-30" })
        .restated,
    ).toBeNull();
    expect(
      reportFinancialsLines(
        { publishedThrough: null, restatements: [] },
        { start: null, end: null },
      ),
    ).toEqual({ publishedThrough: null, restated: null });
  });
});
