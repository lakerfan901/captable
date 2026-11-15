import { describe, expect, it } from "vitest";
import {
  type AudienceHolder,
  audiencePresets,
  audienceProblems,
  deadlineOutcome,
  documentSharePresets,
  isCurrentMember,
  MAX_AUDIENCE,
} from "./audience-core";

const ZERO = "0.000000";

function holder(
  stakeholderId: string,
  over: Partial<AudienceHolder> = {},
): AudienceHolder {
  return {
    stakeholderId,
    memberStatus: "MEMBER",
    preferredUnits: ZERO,
    commonUnits: ZERO,
    hasK1: false,
    noticeEmail: `${stakeholderId.toLowerCase()}@x.test`,
    portal: "ACTIVE",
    ...over,
  };
}

// The integration cast of 8.2: A, B Preferred Members; C Common Member;
// D Prospect; E Financial-Interest-only. Plus G, a Member with no units left,
// and P, a Member with both classes.
const A = holder("A", { preferredUnits: "100.000000" });
const B = holder("B", { preferredUnits: "50.5" });
const C = holder("C", { commonUnits: "10" });
const D = holder("D", { memberStatus: "PROSPECT" });
const E = holder("E", { memberStatus: "FINANCIAL_INTEREST_ONLY", hasK1: true });
const G = holder("G");
const P = holder("P", { preferredUnits: "0.000001", commonUnits: "5" });
const HOLDERS = [A, B, C, D, E, G, P];
const CURRENT = ["A", "B", "C", "P"];

const codes = (r: { refusals: { code: string }[] }) =>
  r.refusals.map((x) => x.code);
const warning = (
  r: { warnings: { code: string; stakeholderIds: string[] }[] },
  code: string,
) => r.warnings.find((w) => w.code === code)?.stakeholderIds;

describe("isCurrentMember", () => {
  it("needs MEMBER status and units > 0", () => {
    expect(HOLDERS.filter(isCurrentMember).map((h) => h.stakeholderId)).toEqual(
      CURRENT,
    );
  });

  it("throws on a malformed unit string rather than guessing", () => {
    expect(() =>
      isCurrentMember(holder("X", { preferredUnits: "1e3" })),
    ).toThrow(RangeError);
    expect(() =>
      isCurrentMember(holder("X", { preferredUnits: "-1" })),
    ).toThrow(RangeError);
  });
});

describe("audiencePresets (P18)", () => {
  it("quarterly: all, Preferred, Common; default all current Members", () => {
    const r = audiencePresets("QUARTERLY", null, HOLDERS, null);
    expect(r.defaultPreset).toBe("ALL_CURRENT_MEMBERS");
    expect(r.presets.map((p) => [p.key, p.label, p.stakeholderIds])).toEqual([
      ["ALL_CURRENT_MEMBERS", "All current Members", ["A", "B", "C", "P"]],
      ["PREFERRED_MEMBERS", "Preferred Members", ["A", "B", "P"]],
      ["COMMON_MEMBERS", "Common Members", ["C", "P"]],
    ]);
  });

  it("annual and general notices default to all current Members", () => {
    expect(audiencePresets("ANNUAL", null, HOLDERS, null).defaultPreset).toBe(
      "ALL_CURRENT_MEMBERS",
    );
    expect(
      audiencePresets("NOTICE", "GENERAL", HOLDERS, null).defaultPreset,
    ).toBe("ALL_CURRENT_MEMBERS");
  });

  it("transfer notice: adds Other Preferred Members (default), without the transferor", () => {
    for (const kind of ["TRANSFER_NOTICE_COPY", "INVOLUNTARY_TRANSFER"]) {
      const r = audiencePresets("NOTICE", kind, HOLDERS, "A");
      expect(r.defaultPreset).toBe("OTHER_PREFERRED_MEMBERS");
      expect(
        r.presets.find((p) => p.key === "OTHER_PREFERRED_MEMBERS")
          ?.stakeholderIds,
      ).toEqual(["B", "P"]);
    }
  });

  it("transfer notice without a transferor has no default and no Other preset", () => {
    for (const t of [null, undefined, ""]) {
      const r = audiencePresets("NOTICE", "TRANSFER_NOTICE_COPY", HOLDERS, t);
      expect(r.defaultPreset).toBeNull();
      expect(r.presets.map((p) => p.key)).not.toContain(
        "OTHER_PREFERRED_MEMBERS",
      );
    }
  });

  it("TAX_K1: only holders with a K-1 attached, never a prospect", () => {
    const withK1 = [
      holder("A", { preferredUnits: "1", hasK1: true }),
      holder("D", { memberStatus: "PROSPECT", hasK1: true }),
      E,
      C,
    ];
    const r = audiencePresets("TAX_K1", null, withK1, null);
    expect(r.defaultPreset).toBe("K1_ATTACHED");
    expect(r.presets).toEqual([
      {
        key: "K1_ATTACHED",
        label: "Holders with a K-1 attached",
        stakeholderIds: ["A", "E"],
      },
    ]);
  });

  it("a notice kind on a non-NOTICE report is ignored", () => {
    expect(
      audiencePresets("QUARTERLY", "TRANSFER_NOTICE_COPY", HOLDERS, "A")
        .defaultPreset,
    ).toBe("ALL_CURRENT_MEMBERS");
  });

  it("document share presets are the three member presets", () => {
    expect(documentSharePresets(HOLDERS).map((p) => p.key)).toEqual([
      "ALL_CURRENT_MEMBERS",
      "PREFERRED_MEMBERS",
      "COMMON_MEMBERS",
    ]);
  });

  it("no holders: empty presets", () => {
    expect(
      audiencePresets("QUARTERLY", null, [], null).presets.every(
        (p) => p.stakeholderIds.length === 0,
      ),
    ).toBe(true);
  });
});

describe("audienceProblems: refusals", () => {
  it("the default audience of a quarterly report has no problem", () => {
    expect(
      audienceProblems("QUARTERLY", CURRENT, HOLDERS, { email: true }),
    ).toEqual({
      refusals: [],
      warnings: [],
    });
  });

  it("refuses a prospect", () => {
    const r = audienceProblems("QUARTERLY", [...CURRENT, "D"], HOLDERS);
    expect(r.refusals).toEqual([
      {
        code: "PROSPECT",
        stakeholderId: "D",
        message: "A prospect cannot receive a report.",
      },
    ]);
  });

  it("refuses a K-1-less holder on a TAX_K1 report, and a prospect even with a K-1", () => {
    const withK1 = [
      holder("A", { preferredUnits: "1", hasK1: true }),
      C,
      E,
      holder("D", { memberStatus: "PROSPECT", hasK1: true }),
    ];
    expect(codes(audienceProblems("TAX_K1", ["A", "E"], withK1))).toEqual([]);
    const r = audienceProblems("TAX_K1", ["A", "C", "D"], withK1);
    expect(r.refusals.map((x) => [x.code, x.stakeholderId])).toEqual([
      ["K1_MISSING", "C"],
      ["PROSPECT", "D"],
    ]);
  });

  it("refuses a foreign or invented id (another company's holder)", () => {
    const r = audienceProblems("QUARTERLY", ["A", "F-other-company"], HOLDERS);
    expect(r.refusals.map((x) => [x.code, x.stakeholderId])).toEqual([
      ["UNKNOWN_HOLDER", "F-other-company"],
    ]);
  });

  it("refuses ids that look like object prototype keys", () => {
    for (const id of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "",
    ]) {
      expect(codes(audienceProblems("QUARTERLY", [id], HOLDERS))).toEqual([
        "UNKNOWN_HOLDER",
      ]);
    }
  });

  it("refuses a duplicate id", () => {
    const r = audienceProblems("QUARTERLY", ["A", "B", "A"], HOLDERS);
    expect(r.refusals.map((x) => [x.code, x.stakeholderId])).toEqual([
      ["DUPLICATE", "A"],
    ]);
  });

  it("ids are case- and whitespace-sensitive", () => {
    expect(codes(audienceProblems("QUARTERLY", ["a", " A"], HOLDERS))).toEqual([
      "UNKNOWN_HOLDER",
      "UNKNOWN_HOLDER",
    ]);
  });

  it("refuses an empty selection", () => {
    expect(codes(audienceProblems("QUARTERLY", [], HOLDERS))).toEqual([
      "EMPTY",
    ]);
  });

  it("refuses more than 500 distinct holders", () => {
    const many = Array.from({ length: MAX_AUDIENCE + 1 }, (_, i) =>
      holder(`H${i}`, { preferredUnits: "1" }),
    );
    const ids = many.map((h) => h.stakeholderId);
    expect(
      codes(audienceProblems("QUARTERLY", ids.slice(0, MAX_AUDIENCE), many)),
    ).toEqual([]);
    expect(codes(audienceProblems("QUARTERLY", ids, many))).toEqual([
      "TOO_MANY",
    ]);
  });

  it("with email ticked, refuses a holder without a notice address", () => {
    const noMail = holder("N", { preferredUnits: "1", noticeEmail: "  " });
    const nullMail = holder("M", { preferredUnits: "1", noticeEmail: null });
    const hs = [A, noMail, nullMail];
    expect(
      codes(
        audienceProblems("QUARTERLY", ["A", "N", "M"], hs, { email: true }),
      ),
    ).toEqual(["NO_NOTICE_ADDRESS", "NO_NOTICE_ADDRESS"]);
    expect(
      codes(
        audienceProblems("QUARTERLY", ["A", "N", "M"], hs, { email: false }),
      ),
    ).toEqual([]);
  });

  it("refuses a transfer notice not linked to a transfer", () => {
    expect(
      codes(
        audienceProblems("NOTICE", ["B"], HOLDERS, {
          noticeKind: "TRANSFER_NOTICE_COPY",
        }),
      ),
    ).toEqual(["TRANSFER_NOT_LINKED"]);
  });
});

describe("audienceProblems: warnings (departures from the default)", () => {
  it("current Member not selected", () => {
    const r = audienceProblems("QUARTERLY", ["A", "B", "C"], HOLDERS);
    expect(r.refusals).toEqual([]);
    expect(r.warnings).toEqual([
      {
        code: "MEMBERS_NOT_SELECTED",
        stakeholderIds: ["P"],
        message: "1 current Member is not selected.",
      },
    ]);
  });

  it("non-Members selected (Financial-Interest-only, a Member with no units)", () => {
    const r = audienceProblems("QUARTERLY", [...CURRENT, "E", "G"], HOLDERS);
    expect(warning(r, "NOT_MEMBERS_SELECTED")).toEqual(["E", "G"]);
    expect(
      r.warnings.find((w) => w.code === "NOT_MEMBERS_SELECTED")?.message,
    ).toBe("2 selected holders are not Members.");
  });

  it("transfer notice: transferor selected, Common-only Member selected, other Preferred missing", () => {
    const opts = { noticeKind: "TRANSFER_NOTICE_COPY", transferorId: "A" };
    expect(audienceProblems("NOTICE", ["B", "P"], HOLDERS, opts)).toEqual({
      refusals: [],
      warnings: [],
    });
    const r = audienceProblems("NOTICE", ["A", "B", "C"], HOLDERS, opts);
    expect(r.refusals).toEqual([]);
    expect(warning(r, "MEMBERS_NOT_SELECTED")).toEqual(["P"]);
    expect(warning(r, "TRANSFEROR_SELECTED")).toEqual(["A"]);
    expect(warning(r, "OUTSIDE_DEFAULT_SELECTED")).toEqual(["C"]);
    expect(warning(r, "NOT_MEMBERS_SELECTED")).toBeUndefined();
  });

  it("transfer notice: a transferor with no units left is named once, as the transferor", () => {
    const opts = { noticeKind: "INVOLUNTARY_TRANSFER", transferorId: "G" };
    const r = audienceProblems("NOTICE", ["A", "B", "P", "G"], HOLDERS, opts);
    expect(warning(r, "TRANSFEROR_SELECTED")).toEqual(["G"]);
    expect(warning(r, "NOT_MEMBERS_SELECTED")).toBeUndefined();
  });

  it("TAX_K1: a holder with a K-1 left out; non-Members are normal there", () => {
    const withK1 = [holder("A", { preferredUnits: "1", hasK1: true }), E, C];
    const r = audienceProblems("TAX_K1", ["E"], withK1);
    expect(r.refusals).toEqual([]);
    expect(r.warnings.map((w) => [w.code, w.stakeholderIds])).toEqual([
      ["K1_HOLDERS_NOT_SELECTED", ["A"]],
    ]);
  });

  it("a holder with no portal access and no email receives nothing", () => {
    const hs = [
      A,
      holder("Q", { preferredUnits: "1", portal: "NONE" }),
      holder("R", { preferredUnits: "1", portal: "INVITED" }),
    ];
    const r = audienceProblems("QUARTERLY", ["A", "Q", "R"], hs, {
      email: false,
    });
    expect(warning(r, "RECEIVES_NOTHING")).toEqual(["Q"]);
    const emailed = audienceProblems("QUARTERLY", ["A", "Q", "R"], hs, {
      email: true,
    });
    expect(warning(emailed, "RECEIVES_NOTHING")).toBeUndefined();
  });

  it("refused ids are not repeated as warnings", () => {
    const r = audienceProblems("QUARTERLY", [...CURRENT, "D", "zzz"], HOLDERS);
    expect(codes(r)).toEqual(["PROSPECT", "UNKNOWN_HOLDER"]);
    expect(r.warnings).toEqual([]);
  });
});

describe("deadlineOutcome (P22)", () => {
  it("quarterly, email ticked, all current Members: DONE", () => {
    const r = deadlineOutcome("QUARTERLY", true, CURRENT, CURRENT);
    expect(r.outcome).toBe("DONE");
    expect(r.sentence).toMatch(/marked done/);
  });

  it("extra holders and order do not matter", () => {
    expect(
      deadlineOutcome("ANNUAL", true, ["P", "E", "C", "B", "A"], CURRENT)
        .outcome,
    ).toBe("DONE");
  });

  it("one Member missing: STAYS_OPEN with the count", () => {
    const r = deadlineOutcome("QUARTERLY", true, ["A", "B", "C"], CURRENT);
    expect(r.outcome).toBe("STAYS_OPEN");
    expect(r.sentence).toContain("1 current Member is not selected");
    expect(r.sentence).toContain("compliance page");
  });

  it("email unticked: STAYS_OPEN, whoever is selected", () => {
    const r = deadlineOutcome("QUARTERLY", false, CURRENT, CURRENT);
    expect(r.outcome).toBe("STAYS_OPEN");
    expect(r.sentence).toContain("not emailed");
  });

  it("a truthy non-boolean is not 'email ticked'", () => {
    expect(
      deadlineOutcome(
        "QUARTERLY",
        "yes" as unknown as boolean,
        CURRENT,
        CURRENT,
      ).outcome,
    ).toBe("STAYS_OPEN");
  });

  it("no current Members: STAYS_OPEN (conservative)", () => {
    expect(deadlineOutcome("QUARTERLY", true, ["E"], []).outcome).toBe(
      "STAYS_OPEN",
    );
  });

  it("TAX_K1: K1_COVERAGE when emailed, STAYS_OPEN when not", () => {
    expect(deadlineOutcome("TAX_K1", true, ["A"], CURRENT).outcome).toBe(
      "K1_COVERAGE",
    );
    expect(deadlineOutcome("TAX_K1", false, ["A"], CURRENT).outcome).toBe(
      "STAYS_OPEN",
    );
  });

  it("NOTICE follows the quarterly rule over the ids passed", () => {
    expect(
      deadlineOutcome("NOTICE", true, ["B", "P"], ["B", "P"]).outcome,
    ).toBe("DONE");
    expect(deadlineOutcome("NOTICE", true, ["B"], ["B", "P"]).outcome).toBe(
      "STAYS_OPEN",
    );
  });

  it("duplicates in either list do not change the result", () => {
    expect(
      deadlineOutcome(
        "QUARTERLY",
        true,
        [...CURRENT, ...CURRENT],
        [...CURRENT, "A"],
      ).outcome,
    ).toBe("DONE");
    expect(
      deadlineOutcome("QUARTERLY", true, ["A", "A", "B", "C"], CURRENT)
        .sentence,
    ).toContain("1 current Member");
  });
});
