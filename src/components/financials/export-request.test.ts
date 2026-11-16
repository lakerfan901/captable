import { describe, expect, it } from "vitest";
import { ZFinancialsExportView } from "../../lib/xlsx/financials-export-input";
import { backFromPrint, exportRequestOf, printHref } from "./export-request";
import { DEFAULT_PERIOD_STATE } from "./period-state";

const span = { inception: "2026-01-01", last: "2027-09-01" };

describe("the export request is the view on screen", () => {
  it("quarters: the trend window of the charts, the selected quarter, the comparison", () => {
    const r = exportRequestOf(DEFAULT_PERIOD_STATE, span, "fund");
    expect(r).toEqual({
      view: "fund",
      grain: "quarter",
      from: "2026-01-01",
      to: "2027-09-01",
      focus: "2027-Q3",
      compare: "previous",
    });
    expect(ZFinancialsExportView.safeParse(r).success).toBe(true);
  });

  it("a drilled quarter exports its months", () => {
    const r = exportRequestOf(
      { ...DEFAULT_PERIOD_STATE, period: "2027-Q2", drill: ["2027-Q2"] },
      span,
      "mine",
    );
    expect(r).toMatchObject({
      view: "mine",
      grain: "month",
      from: "2027-04-01",
      to: "2027-06-01",
      focus: "2027-Q2",
    });
  });

  it("since inception has no comparison", () => {
    const r = exportRequestOf(
      { ...DEFAULT_PERIOD_STATE, grain: "inception" },
      span,
      "fund",
    );
    expect(r).toMatchObject({ focus: "inception", compare: "none" });
  });

  it("the input refuses a reversed or malformed range", () => {
    const base = exportRequestOf(DEFAULT_PERIOD_STATE, span, "fund");
    expect(
      ZFinancialsExportView.safeParse({
        ...base,
        from: "2027-09-01",
        to: "2026-01-01",
      }).success,
    ).toBe(false);
    expect(
      ZFinancialsExportView.safeParse({ ...base, to: "2027-09-15" }).success,
    ).toBe(false);
    expect(
      ZFinancialsExportView.safeParse({ ...base, focus: "Q3" }).success,
    ).toBe(false);
  });
});

describe("print links", () => {
  it("the print route keeps the page's query and asks to print", () => {
    expect(
      printHref("/portal/pa_1/financials", "?grain=month&period=2027-02"),
    ).toBe(
      "/portal/pa_1/financials/print?grain=month&period=2027-02&autoprint=1",
    );
  });
  it("back from print is the page with the same view", () => {
    expect(
      backFromPrint(
        "/acme/financials/dashboard/print",
        "source=preview&holder=h1&autoprint=1",
      ),
    ).toBe("/acme/financials/dashboard?source=preview&holder=h1");
  });
});
