import { describe, expect, it } from "vitest";
import {
  CUSTOM_DEADLINE_TEMPLATES,
  type ExistingDeadline,
  economicsIncoming,
  type IncomingDeadline,
  isSyncClosure,
  LEDGER_COMPLETION_NOTE,
  normalizeSection,
  planDeadlineSync,
  ruleIncoming,
  splitLedgerFeed,
  supersededNote,
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
    ruleKey: over.dedupeKey.split(":")[1] ?? over.dedupeKey,
    title: "Target Sale Date",
    status: "OPEN",
    source: "ECONOMICS",
    closedBySync: false,
    ...over,
  };
}

const EMPTY = {
  create: [],
  update: [],
  complete: [],
  closeMissing: [],
  supersede: [],
  reopen: [],
};

/** The range the ledger feed was read for in the rule tests below. */
const RANGE = { from: "2026-10-01", to: "2028-01-01" };

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
      ruleKey: c.ruleKey,
      closedBySync: false,
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
      closeMissing: [],
      supersede: [],
      reopen: [],
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
      closeMissing: [],
      supersede: [],
      reopen: [],
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
      expect(plan).toEqual(EMPTY);
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
      closeMissing: [],
      supersede: [],
      reopen: [],
    });
  });

  it("5: an existing key missing from incoming is left alone", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:CALL_NOTICE_DUE:line1", dueOn: "2027-01-15" })],
      [],
    );
    expect(plan).toEqual(EMPTY);
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
    expect(plan).toEqual(EMPTY);
  });
});

describe("ledger rows that leave, move or come back (coordinator rulings)", () => {
  it("R1: an OPEN ledger row in range that left the feed is completed", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:CALL_NOTICE_DUE:line1", dueOn: "2027-01-20" })],
      [],
      RANGE,
    );
    expect(plan).toEqual({
      ...EMPTY,
      closeMissing: ["id-E:CALL_NOTICE_DUE:line1"],
    });
  });

  it("R1: rows outside the range, closed rows and RULE rows are left alone", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:TARGET_SALE_DATE:2031-11-30",
          dueOn: "2031-11-30",
        }),
        row({ dedupeKey: "E:FORFEITURE_DATE:d1", dueOn: "2026-09-01" }),
        row({
          dedupeKey: "E:CREDIT_DATE:d1",
          dueOn: "2027-02-19",
          status: "DONE",
        }),
        row({
          dedupeKey: "QUARTERLY_REPORT:2026Q4",
          dueOn: "2027-02-14",
          source: "RULE",
        }),
        row({
          dedupeKey: "PO_RESOLUTION_COPY:r1",
          dueOn: "2027-02-14",
          source: "RESOLUTION",
        }),
      ],
      [],
      RANGE,
    );
    expect(plan).toEqual(EMPTY);
  });

  it("R1: an OPEN ledger row still in the feed, however old, stays open", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:CALL_NOTICE_DUE:line1", dueOn: "2026-10-05" })],
      [
        econ(
          "E:CALL_NOTICE_DUE:line1",
          "2026-10-05",
          false,
          "Target Sale Date",
        ),
      ],
      RANGE,
    );
    expect(plan).toEqual(EMPTY);
  });

  it("R2: a date-keyed row whose kind reappears with another date is superseded", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:EXTENSION_REQUEST_DUE:2027-02-28",
          dueOn: "2027-02-28",
        }),
      ],
      [econ("E:EXTENSION_REQUEST_DUE:2027-05-31", "2027-05-31")],
      RANGE,
    );
    expect(plan.supersede).toEqual([
      {
        id: "id-E:EXTENSION_REQUEST_DUE:2027-02-28",
        note: "Superseded: date changed to 2027-05-31",
      },
    ]);
    expect(plan.closeMissing).toEqual([]);
    expect(plan.create.map((c) => c.dedupeKey)).toEqual([
      "E:EXTENSION_REQUEST_DUE:2027-05-31",
    ]);
  });

  it("R2: without a replacement of the same kind the row is completed (R1)", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:OCD_NOTICE_DUE:2027-01-10", dueOn: "2027-01-10" })],
      [econ("E:TARGET_SALE_DATE:2031-11-30", "2031-11-30")],
      RANGE,
    );
    expect(plan.supersede).toEqual([]);
    expect(plan.closeMissing).toEqual(["id-E:OCD_NOTICE_DUE:2027-01-10"]);
  });

  it("R2: a kind that is not date-keyed is never superseded", () => {
    const plan = planDeadlineSync(
      [row({ dedupeKey: "E:CALL_NOTICE_DUE:line1", dueOn: "2027-01-20" })],
      [econ("E:CALL_NOTICE_DUE:line2", "2027-03-20")],
      RANGE,
    );
    expect(plan.supersede).toEqual([]);
    expect(plan.closeMissing).toEqual(["id-E:CALL_NOTICE_DUE:line1"]);
  });

  it("R3: a row the sync closed reopens when the feed reports it open again", () => {
    for (const status of ["DONE", "NOT_APPLICABLE"] as const) {
      const plan = planDeadlineSync(
        [
          row({
            dedupeKey: "E:DISTRIBUTION_DEADLINE:2026-12-31",
            dueOn: "2027-02-14",
            status,
            closedBySync: true,
          }),
        ],
        [econ("E:DISTRIBUTION_DEADLINE:2026-12-31", "2027-02-14")],
        RANGE,
      );
      expect(plan).toEqual({
        ...EMPTY,
        reopen: [
          {
            id: "id-E:DISTRIBUTION_DEADLINE:2026-12-31",
            dueOn: "2027-02-14",
            title: "Target Sale Date",
            resetReminders: false,
          },
        ],
      });
    }
  });

  it("R3: a row the sync closed stays closed while the feed says done", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:DISTRIBUTION_DEADLINE:2026-12-31",
          dueOn: "2027-02-14",
          status: "DONE",
          closedBySync: true,
        }),
      ],
      [econ("E:DISTRIBUTION_DEADLINE:2026-12-31", "2027-02-14", true)],
      RANGE,
    );
    expect(plan).toEqual(EMPTY);
  });

  it("R3: a row a user closed is never reopened", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:CALL_NOTICE_DUE:line1",
          dueOn: "2027-01-20",
          status: "NOT_APPLICABLE",
          closedBySync: false,
        }),
      ],
      [econ("E:CALL_NOTICE_DUE:line1", "2027-01-20")],
      RANGE,
    );
    expect(plan).toEqual(EMPTY);
  });
});

describe("isSyncClosure", () => {
  const base = {
    completedById: null,
    satisfiedByType: "MANUAL",
    note: LEDGER_COMPLETION_NOTE,
  };
  it("recognizes the ledger completion and the superseded marking", () => {
    expect(isSyncClosure({ ...base, status: "DONE" })).toBe(true);
    expect(
      isSyncClosure({
        status: "NOT_APPLICABLE",
        completedById: null,
        satisfiedByType: null,
        note: supersededNote("2027-05-31"),
      }),
    ).toBe(true);
  });
  it("rejects anything a user closed or annotated", () => {
    expect(
      isSyncClosure({ ...base, status: "DONE", completedById: "m1" }),
    ).toBe(false);
    expect(isSyncClosure({ ...base, status: "DONE", note: "Paid" })).toBe(
      false,
    );
    expect(
      isSyncClosure({ ...base, status: "DONE", satisfiedByType: "RESOLUTION" }),
    ).toBe(false);
    expect(
      isSyncClosure({
        status: "NOT_APPLICABLE",
        completedById: null,
        satisfiedByType: null,
        note: "n/a",
      }),
    ).toBe(false);
    expect(isSyncClosure({ ...base, status: "OPEN" })).toBe(false);
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

describe("date-keyed ledger items beyond the calendar horizon", () => {
  // Today 2026-11-25; the calendar horizon ends 400 days later.
  const HORIZON_END = "2027-12-30";
  const RANGE_H = { from: "2026-10-26", to: HORIZON_END };

  it("splits the feed: far date-keyed items are replacements only", () => {
    const { inHorizon, farReplacements } = splitLedgerFeed(
      [
        econ("E:CALL_NOTICE_DUE:line1", "2027-01-20"),
        econ("E:TARGET_SALE_DATE:2028-11-30", "2028-11-30"),
        econ("E:MEMBER_LOAN_MATURITY:loan1", "2029-06-30"),
        econ("E:DISTRIBUTION_DEADLINE:2028-03-31", "2028-05-15"),
      ],
      HORIZON_END,
    );
    expect(inHorizon.map((d) => d.dedupeKey)).toEqual([
      "E:CALL_NOTICE_DUE:line1",
    ]);
    expect(farReplacements.map((d) => d.dedupeKey)).toEqual([
      "E:TARGET_SALE_DATE:2028-11-30",
    ]);
  });

  it("a Target Sale Date moved past the horizon supersedes the old row and creates nothing", () => {
    const old = row({
      dedupeKey: "E:TARGET_SALE_DATE:2027-11-30",
      dueOn: "2027-11-30",
    });
    const existing = [old];
    const feed = [econ("E:TARGET_SALE_DATE:2028-11-30", "2028-11-30")];
    const { inHorizon, farReplacements } = splitLedgerFeed(feed, HORIZON_END);
    const plan = planDeadlineSync(
      existing,
      inHorizon,
      RANGE_H,
      farReplacements,
    );
    expect(plan).toEqual({
      ...EMPTY,
      supersede: [
        {
          id: "id-E:TARGET_SALE_DATE:2027-11-30",
          note: "Superseded: date changed to 2028-11-30",
        },
      ],
    });

    // Second run: the old row is now NOT_APPLICABLE (closed by the sync) and
    // still absent from the feed, so nothing changes.
    const rerun = planDeadlineSync(
      [
        {
          ...old,
          status: "NOT_APPLICABLE",
          closedBySync: true,
        },
      ],
      inHorizon,
      RANGE_H,
      farReplacements,
    );
    expect(rerun).toEqual(EMPTY);
  });

  it("without the far replacement the old row is completed (the earlier gap)", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:TARGET_SALE_DATE:2027-11-30",
          dueOn: "2027-11-30",
        }),
      ],
      [],
      RANGE_H,
    );
    expect(plan).toEqual({
      ...EMPTY,
      closeMissing: ["id-E:TARGET_SALE_DATE:2027-11-30"],
    });
  });

  it("a far item of another kind is no replacement", () => {
    const plan = planDeadlineSync(
      [
        row({
          dedupeKey: "E:EXTENSION_REQUEST_DUE:2027-02-28",
          dueOn: "2027-02-28",
        }),
      ],
      [],
      RANGE_H,
      [econ("E:TARGET_SALE_DATE:2028-11-30", "2028-11-30")],
    );
    expect(plan.supersede).toEqual([]);
    expect(plan.closeMissing).toEqual([
      "id-E:EXTENSION_REQUEST_DUE:2027-02-28",
    ]);
  });
});
