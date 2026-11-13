import { describe, expect, it } from "vitest";
import {
  CUSTOM_DEADLINE_TEMPLATES,
  type ExistingDeadline,
  economicsIncoming,
  type IncomingDeadline,
  normalizeSection,
  planDeadlineSync,
  ruleIncoming,
  templateDueOn,
} from "./compliance-core";
import { addDays, generateRuleDeadlines, type Ymd } from "./dates";

const HOLIDAYS = new Set(["2026-11-26", "2026-12-25", "2027-01-01"]);
function fakeAddBusinessDays(ymd: Ymd, n: number): Ymd {
  let current = ymd;
  let left = n;
  while (left > 0) {
    current = addDays(current, 1);
    const day = new Date(`${current}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6 && !HOLIDAYS.has(current)) left -= 1;
  }
  return current;
}

function econ(
  dedupeKey: string,
  dueOn: Ymd,
  done = false,
  title = "Target Sale Date",
): IncomingDeadline {
  return {
    ruleKey: dedupeKey.split(":")[1] ?? dedupeKey,
    dedupeKey,
    title,
    section: "2.4",
    dueOn,
    source: "ECONOMICS",
    done,
  };
}

function row(
  over: Partial<ExistingDeadline> & { dedupeKey: string; dueOn: Ymd },
): ExistingDeadline {
  return {
    id: `id-${over.dedupeKey}`,
    title: "Target Sale Date",
    status: "OPEN",
    source: "ECONOMICS",
    ...over,
  };
}

describe("planDeadlineSync", () => {
  it("1: creates the seven G3 rule deadlines once, then nothing", () => {
    const incoming = generateRuleDeadlines({
      firstAdmittedOn: "2026-11-20",
      today: "2026-11-25",
      horizonDays: 400,
    }).map(ruleIncoming);
    expect(incoming).toHaveLength(7);

    const first = planDeadlineSync([], incoming);
    expect(first.create.map((c) => [c.dedupeKey, c.dueOn])).toEqual([
      ["QUARTERLY_REPORT:2026Q4", "2027-02-14"],
      ["ANNUAL_FINANCIALS:2026", "2027-03-31"],
      ["K1_TARGET:2026", "2027-03-31"],
      ["QUARTERLY_REPORT:2027Q1", "2027-05-15"],
      ["QUARTERLY_REPORT:2027Q2", "2027-08-14"],
      ["K1_FINAL:2026", "2027-09-15"],
      ["QUARTERLY_REPORT:2027Q3", "2027-11-14"],
    ]);
    expect(first.update).toEqual([]);
    expect(first.complete).toEqual([]);

    const existing: ExistingDeadline[] = first.create.map((c, i) => ({
      id: `d${i}`,
      dedupeKey: c.dedupeKey,
      dueOn: c.dueOn,
      title: c.title,
      status: "OPEN",
      source: c.source,
    }));
    expect(planDeadlineSync(existing, incoming)).toEqual({
      create: [],
      update: [],
      complete: [],
    });
  });

  it("2: an OPEN row with a moved date is updated and its reminders reset", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:TARGET_SALE_DATE", dueOn: "2031-11-30" })],
      [econ("E:TARGET_SALE_DATE", "2032-11-30")],
    );
    expect(plan).toEqual({
      create: [],
      update: [
        {
          id: "id-E:TARGET_SALE_DATE",
          dueOn: "2032-11-30",
          title: "Target Sale Date",
          resetReminders: true,
        },
      ],
      complete: [],
    });
  });

  it("a title change alone updates without resetting reminders", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:X", dueOn: "2031-11-30", title: "Old" })],
      [econ("E:X", "2031-11-30", false, "New")],
    );
    expect(plan.update).toEqual([
      {
        id: "id-E:X",
        dueOn: "2031-11-30",
        title: "New",
        resetReminders: false,
      },
    ]);
  });

  it("3: a DONE row is never touched, even with another date", () => {
    for (const status of ["DONE", "NOT_APPLICABLE"] as const) {
      const plan = planDeadlineSync(
        [row({ dedupeKey: "E:TARGET_SALE_DATE", dueOn: "2031-11-30", status })],
        [econ("E:TARGET_SALE_DATE", "2032-11-30")],
      );
      expect(plan).toEqual({ create: [], update: [], complete: [] });
    }
  });

  it("4: an OPEN row whose incoming item is done is completed", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:DISTRIBUTION_DEADLINE:2027-03-31",
          dueOn: "2027-05-15",
        }),
      ],
      [econ("E:DISTRIBUTION_DEADLINE:2027-03-31", "2027-05-15", true)],
    );
    expect(plan).toEqual({
      create: [],
      update: [],
      complete: ["id-E:DISTRIBUTION_DEADLINE:2027-03-31"],
    });
  });

  it("5: an existing key missing from incoming is left alone", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:CALL_NOTICE_DUE:line1", dueOn: "2027-01-15" })],
      [],
    );
    expect(plan).toEqual({ create: [], update: [], complete: [] });
  });

  it("an incoming item that is already done is created (the caller completes it)", () => {
    const plan = planDeadlineSync([], [econ("E:A", "2027-05-15", true)]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]?.done).toBe(true);
    expect(plan.complete).toEqual([]);
  });

  it("rows of other sources are ignored even when a key matches", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:A",
          dueOn: "2027-01-01",
          source: "MANUAL",
          title: "x",
        }),
      ],
      [econ("E:A", "2027-05-15", true)],
    );
    expect(plan).toEqual({ create: [], update: [], complete: [] });
  });
});

describe("economicsIncoming", () => {
  it("drops the quarterly report and INFO items and maps the rest", () => {
    const items = economicsIncoming([
      {
        key: "QUARTERLY_REPORT_DEADLINE:2026-12-31",
        kind: "QUARTERLY_REPORT_DEADLINE",
        dueOn: "2027-02-14",
        label: "Quarterly report",
        oaSection: "§8.2",
        status: "OPEN",
      },
      {
        key: "DISSOLUTION_ELECTION_AVAILABLE:2032-05-29",
        kind: "DISSOLUTION_ELECTION_AVAILABLE",
        dueOn: "2032-05-29",
        label: "Dissolution election becomes available",
        oaSection: "§11.1(d)",
        status: "INFO",
      },
      {
        key: "DISTRIBUTION_DEADLINE:2026-12-31",
        kind: "DISTRIBUTION_DEADLINE",
        dueOn: "2027-02-14",
        label: "Distribute Available Cash for Q4 2026",
        oaSection: "§5.6(a)",
        status: "NOT_REQUIRED",
      },
      {
        key: "CALL_NOTICE_DUE:line1",
        kind: "CALL_NOTICE_DUE",
        dueOn: "2027-01-15",
        label: "Call Notice payment due",
        oaSection: "§4.9",
        status: "OVERDUE",
      },
    ]);
    expect(items).toEqual([
      {
        ruleKey: "DISTRIBUTION_DEADLINE",
        dedupeKey: "E:DISTRIBUTION_DEADLINE:2026-12-31",
        title: "Distribute Available Cash for Q4 2026",
        section: "5.6(a)",
        dueOn: "2027-02-14",
        source: "ECONOMICS",
        done: true,
      },
      {
        ruleKey: "CALL_NOTICE_DUE",
        dedupeKey: "E:CALL_NOTICE_DUE:line1",
        title: "Call Notice payment due",
        section: "4.9",
        dueOn: "2027-01-15",
        source: "ECONOMICS",
        done: false,
      },
    ]);
  });

  it("normalizes sections", () => {
    expect(normalizeSection("§ 4.8(b)")).toBe("4.8(b)");
    expect(normalizeSection("8.2")).toBe("8.2");
    expect(normalizeSection("§")).toBeNull();
    expect(normalizeSection(null)).toBeNull();
  });
});

describe("custom deadline templates", () => {
  it("computes calendar-day and business-day offsets", () => {
    const due = (key: keyof typeof CUSTOM_DEADLINE_TEMPLATES, on: Ymd) =>
      templateDueOn(
        CUSTOM_DEADLINE_TEMPLATES[key],
        on,
        fakeAddBusinessDays,
        addDays,
      );
    expect(due("TAX_PROCEEDING_NOTICE", "2027-03-01")).toBe("2027-03-11");
    expect(due("SUCCESSOR_ACCEPTANCE", "2027-01-01")).toBe("2027-06-30");
    // +10 BD from 2026-11-17 skips Thanksgiving (G3 test 10).
    expect(due("PO_TITLE_DOCUMENTS", "2026-11-17")).toBe("2026-12-02");
    expect(due("PO_FUNDS_REMIT", "2026-12-23")).toBe("2026-12-31");
    expect(due("FORM_1065", "2027-03-01")).toBeNull();
  });
});
