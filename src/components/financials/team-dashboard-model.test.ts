import { describe, expect, it } from "vitest";
import type { FundMonthJson } from "../../lib/llc/financial-series";
import {
  type DriftEntry,
  defaultRange,
  driftInRange,
  driftSentence,
  fieldLabel,
  fieldValue,
  holdersSentence,
  parseSourceState,
  rangeLabel,
  rangeOptions,
  rangeProblem,
  restateConfirmSentence,
  restateResultText,
  restateRows,
  serializeSourceState,
  sourceOptions,
  statusLine,
} from "./team-dashboard-model";

function month(m: string, over: Partial<FundMonthJson> = {}): FundMonthJson {
  return {
    schemaVersion: 1,
    month: m,
    asOf: m.replace(/-01$/, "-28"),
    inProgress: false,
    grossRevenue: 100_000,
    otherIncome: 0,
    assetSaleProceeds: 0,
    insuranceProceeds: 0,
    totalExpenses: 30_000,
    operatingExpenses: 30_000,
    capitalFundedExpenses: 0,
    expensesByCategory: [{ category: "POWER", amount: 30_000 }],
    managementFeeAccrued: 5_000,
    managementFeePaid: 0,
    managementFeeUnpaid: 5_000,
    netOperatingIncome: 65_000,
    reserveBalance: 10_000,
    reservesByKind: [{ kind: "MINIMUM_OPERATING", balance: 10_000 }],
    minimumReserve: 10_000,
    reservesEstablished: 0,
    reservesReleased: 0,
    availableCash: 55_000,
    distributions: {
      preferredReturn: 0,
      returnOfCapital: 0,
      residualPreferred: 0,
      residualCommon: 0,
      gross: 0,
    },
    capitalReceived: 0,
    paidInCapital: 1_000_000,
    unreturnedCapital: 1_000_000,
    preferredReturnAccruedToDate: 0,
    preferredReturnPaidToDate: 0,
    preferredReturnUnpaid: 0,
    committed: 1_000_000,
    uncalled: 0,
    utilizationBps: 9_000,
    memberLoansOutstanding: 0,
    orgExpenseCap: { counted: 0, limit: 0 },
    ...over,
  };
}

const params = (o: Record<string, string>) => (k: string) => o[k] ?? null;
const rules = { canPreview: true, holderIds: ["h1", "h2"] };

describe("parseSourceState", () => {
  it("defaults to live", () => {
    expect(parseSourceState(params({}), rules)).toEqual({
      source: "live",
      holder: null,
      section: "fund",
    });
  });
  it("reads published and preview", () => {
    expect(
      parseSourceState(params({ source: "published" }), rules).source,
    ).toBe("published");
    expect(
      parseSourceState(
        params({ source: "preview", holder: "h2", section: "mine" }),
        rules,
      ),
    ).toEqual({ source: "preview", holder: "h2", section: "mine" });
  });
  it("never previews without portal: read", () => {
    expect(
      parseSourceState(params({ source: "preview", holder: "h1" }), {
        canPreview: false,
        holderIds: [],
      }),
    ).toEqual({ source: "live", holder: null, section: "fund" });
  });
  it("takes the first holder when the URL names one not on the list", () => {
    expect(
      parseSourceState(params({ source: "preview", holder: "other" }), rules)
        .holder,
    ).toBe("h1");
  });
  it("ignores section outside preview and garbage sources", () => {
    expect(
      parseSourceState(params({ source: "x", section: "mine" }), rules),
    ).toEqual({ source: "live", holder: null, section: "fund" });
  });
});

describe("serializeSourceState", () => {
  it("keeps other keys and omits defaults", () => {
    const base = new URLSearchParams("grain=year&source=preview&holder=h1");
    const out = serializeSourceState(
      { source: "live", holder: "h1", section: "mine" },
      base,
    );
    expect(out.toString()).toBe("grain=year");
  });
  it("round-trips preview", () => {
    const out = serializeSourceState({
      source: "preview",
      holder: "h2",
      section: "mine",
    });
    expect(parseSourceState((k) => out.get(k), rules)).toEqual({
      source: "preview",
      holder: "h2",
      section: "mine",
    });
  });
});

describe("sourceOptions", () => {
  it("has no preview option without the permission (absent, not greyed)", () => {
    expect(sourceOptions(false).map((o) => o.key)).toEqual([
      "live",
      "published",
    ]);
    expect(sourceOptions(true).map((o) => o.label)).toEqual([
      "Live",
      "Published",
      "Preview as investor",
    ]);
  });
});

describe("status line", () => {
  it("names both dates", () => {
    expect(
      statusLine({
        snapshotThrough: "2026-06-30",
        booksClosedThrough: "2026-09-30",
        drift: [],
      }),
    ).toBe(
      "Published to investors through Jun 30, 2026 · books closed through Sep 30, 2026",
    );
  });
  it("says when nothing is published", () => {
    expect(
      statusLine({
        snapshotThrough: null,
        booksClosedThrough: null,
        drift: [],
      }),
    ).toBe("Nothing published to investors yet · books not closed");
  });
  it("counts drifted months", () => {
    expect(driftSentence(1)).toBe("1 published month differs from the ledger");
    expect(driftSentence(3)).toBe("3 published months differ from the ledger");
  });
});

describe("fieldLabel / fieldValue", () => {
  const m = month("2026-03-01");
  it("labels catalogue metrics, breakdown lines and unknown paths", () => {
    expect(fieldLabel("grossRevenue")).toEqual({
      label: "Gross Revenue",
      unit: "cents",
    });
    expect(fieldLabel("distributions.gross").label).toBe("Distributions paid");
    expect(fieldLabel("expensesByCategory.REPAIR_AND_REPLACEMENT").label).toBe(
      "Expenses: Repair and replacement",
    );
    expect(fieldLabel("reservesByKind.MINIMUM_OPERATING").label).toBe(
      "Reserves: Minimum operating",
    );
    expect(fieldLabel("utilizationBps").unit).toBe("bps");
    expect(fieldLabel("somethingNew").label).toBe("somethingNew");
  });
  it("reads nested values and keyed lines, null when absent", () => {
    expect(fieldValue(m, "grossRevenue")).toBe(100_000);
    expect(fieldValue(m, "orgExpenseCap.limit")).toBe(0);
    expect(fieldValue(m, "expensesByCategory.POWER")).toBe(30_000);
    expect(fieldValue(m, "expensesByCategory.NETWORK")).toBeNull();
    expect(fieldValue(m, "reservesByKind.MINIMUM_OPERATING")).toBe(10_000);
    expect(fieldValue(m, "utilizationBps")).toBe(9_000);
    expect(
      fieldValue(
        month("2026-03-01", { utilizationBps: null }),
        "utilizationBps",
      ),
    ).toBeNull();
    expect(fieldValue(null, "grossRevenue")).toBeNull();
    expect(fieldValue(m, "nope.deeper")).toBeNull();
  });
});

function drift(over: Partial<DriftEntry> & { month: string }): DriftEntry {
  return {
    fields: [],
    holders: [],
    published: month(over.month),
    ledger: month(over.month),
    ...over,
  };
}

describe("restateRows", () => {
  it("gives the old and new value of each changed figure", () => {
    const e = drift({
      month: "2026-03-01",
      fields: [
        "expensesByCategory.NETWORK",
        "operatingExpenses",
        "utilizationBps",
      ],
      ledger: month("2026-03-01", {
        operatingExpenses: 32_500,
        expensesByCategory: [
          { category: "NETWORK", amount: 2_500 },
          { category: "POWER", amount: 30_000 },
        ],
        utilizationBps: 9_150,
      }),
    });
    expect(restateRows(e)).toEqual([
      {
        field: "expensesByCategory.NETWORK",
        label: "Expenses: Network",
        before: "—",
        after: "$25.00",
      },
      {
        field: "operatingExpenses",
        label: "Operating expenses",
        before: "$300.00",
        after: "$325.00",
      },
      {
        field: "utilizationBps",
        label: "Utilization (as reported by the Manager)",
        before: "90.00%",
        after: "91.50%",
      },
    ]);
  });
  it("lists every non-zero ledger figure for a month never published", () => {
    const e = drift({ month: "2025-12-01", fields: ["*"], published: null });
    const rows = restateRows(e);
    expect(rows.every((r) => r.before === "—")).toBe(true);
    expect(rows.map((r) => r.field)).toContain("grossRevenue");
    expect(rows.map((r) => r.field)).toContain("expensesByCategory.POWER");
    expect(rows.map((r) => r.field)).not.toContain("otherIncome");
    expect(rows.map((r) => r.field)).not.toContain("month");
  });
  it("has no fund rows when only holders drifted", () => {
    const e = drift({
      month: "2026-03-01",
      holders: [
        { stakeholderId: "h1", name: "Alder LLC", fields: ["paidIn"] },
        { stakeholderId: "h2", name: "Bexley Trust", fields: ["*"] },
      ],
    });
    expect(restateRows(e)).toEqual([]);
    expect(holdersSentence(e)).toBe(
      "2 holders' own figures change: Alder LLC, Bexley Trust.",
    );
    expect(holdersSentence(drift({ month: "2026-03-01" }))).toBeNull();
  });
});

describe("restate range", () => {
  const d = [
    drift({ month: "2026-05-01", fields: ["grossRevenue"] }),
    drift({ month: "2026-02-01", fields: ["grossRevenue"] }),
  ];
  it("defaults to the first and last drifted month", () => {
    expect(defaultRange(d)).toEqual({ from: "2026-02-01", to: "2026-05-01" });
    expect(defaultRange([])).toBeNull();
    expect(rangeOptions(d)).toEqual([
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
  });
  it("filters and checks a range", () => {
    expect(
      driftInRange(d, "2026-03-01", "2026-05-01").map((x) => x.month),
    ).toEqual(["2026-05-01"]);
    expect(rangeProblem("2026-05-01", "2026-02-01", d)).toMatch(/after/);
    expect(rangeProblem("2026-03-01", "2026-04-01", d)).toMatch(
      /nothing would change/,
    );
    expect(rangeProblem("2026-02-01", "2026-02-01", d)).toBeNull();
  });
  it("names the months and says Restated in the confirmation", () => {
    expect(rangeLabel("2026-02-01", "2026-05-01")).toBe("Feb 2026 – May 2026");
    expect(rangeLabel("2026-02-01", "2026-02-01")).toBe("Feb 2026");
    const s = restateConfirmSentence([
      "2026-02-01",
      "2026-03-01",
      "2026-05-01",
    ]);
    expect(s).toMatch(/^Feb 2026, Mar 2026 and May 2026: /);
    expect(s).toContain('"Restated"');
    expect(restateConfirmSentence(["2026-02-01"])).toMatch(/this month/);
  });
  it("words the result", () => {
    expect(
      restateResultText({
        months: [{ month: "2026-02-01" }],
        unchanged: [],
      }),
    ).toBe("Restated Feb 2026.");
    expect(
      restateResultText({
        months: [{ month: "2026-02-01" }, { month: "2026-05-01" }],
        unchanged: ["2026-03-01", "2026-04-01"],
      }),
    ).toBe(
      "Restated 2 months. 2 months already matched the ledger and were left as they are.",
    );
  });
});
