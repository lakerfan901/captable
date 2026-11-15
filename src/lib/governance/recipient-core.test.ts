import { describe, expect, it } from "vitest";
import type { AudienceHolder } from "../portal/audience-core";
import {
  canRemoveRecipient,
  invitationEmailsToQueue,
  inviteTargets,
  planAddRecipients,
  type ResendRow,
  removalRefusal,
  resendPlan,
  singleResendRefusal,
} from "./recipient-core";

const NOW = new Date("2026-11-15T12:00:00Z");

describe("removalRefusal / canRemoveRecipient", () => {
  const fresh = {
    sendCount: 0,
    sentAt: null,
    firstViewedAt: null,
    viewCount: 0,
    portalTouched: false,
  };

  it("allows a recipient that was never emailed and never opened", () => {
    expect(removalRefusal(fresh)).toBeNull();
    expect(canRemoveRecipient(fresh)).toBe(true);
  });

  it("refuses once a claim was taken, even before the email was accepted", () => {
    expect(canRemoveRecipient({ ...fresh, sendCount: 1 })).toBe(false);
    expect(removalRefusal({ ...fresh, sendCount: 1 })).toMatch(/emailed/);
  });

  it("refuses an emailed recipient", () => {
    expect(canRemoveRecipient({ ...fresh, sentAt: NOW })).toBe(false);
  });

  it("refuses a recipient that opened the emailed link", () => {
    expect(removalRefusal({ ...fresh, firstViewedAt: NOW })).toMatch(
      /emailed link/,
    );
    expect(canRemoveRecipient({ ...fresh, viewCount: 1 })).toBe(false);
  });

  it("refuses a recipient that opened the report in the portal", () => {
    expect(removalRefusal({ ...fresh, portalTouched: true })).toMatch(
      /investor portal/,
    );
  });
});

function holder(
  id: string,
  over: Partial<AudienceHolder> = {},
): AudienceHolder & { name: string } {
  return {
    stakeholderId: id,
    name: id,
    memberStatus: "MEMBER",
    preferredUnits: "10.000000",
    commonUnits: "0.000000",
    hasK1: false,
    noticeEmail: `${id}@example.com`,
    portal: "NONE",
    ...over,
  };
}

describe("planAddRecipients", () => {
  const holders = [
    holder("a"),
    holder("b"),
    holder("c", { noticeEmail: "" }),
    holder("p", { memberStatus: "PROSPECT" }),
    holder("f", { memberStatus: "FINANCIAL_INTEREST_ONLY" }),
  ];

  it("adds only holders without a row; existing ones are left alone", () => {
    const plan = planAddRecipients(
      "QUARTERLY",
      ["a", "b"],
      holders,
      new Set(["a"]),
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.newIds).toEqual(["b"]);
    expect(plan.alreadyRecipientIds).toEqual(["a"]);
  });

  it("an all-existing request adds nothing and refuses nothing (a double click)", () => {
    const plan = planAddRecipients("QUARTERLY", ["a"], holders, new Set(["a"]));
    expect(plan.refusals).toEqual([]);
    expect(plan.newIds).toEqual([]);
  });

  it("refuses a prospect, a foreign id and a duplicate, as release does", () => {
    const plan = planAddRecipients(
      "QUARTERLY",
      ["b", "p", "zz", "b"],
      holders,
      new Set(),
    );
    expect(plan.refusals.map((r) => r.code).sort()).toEqual([
      "DUPLICATE",
      "PROSPECT",
      "UNKNOWN_HOLDER",
    ]);
  });

  it("with email, refuses a new holder without a notice address but not an existing one", () => {
    expect(
      planAddRecipients("QUARTERLY", ["c"], holders, new Set(), {
        email: true,
      }).refusals.map((r) => r.code),
    ).toEqual(["NO_NOTICE_ADDRESS"]);
    expect(
      planAddRecipients("QUARTERLY", ["c", "b"], holders, new Set(["c"]), {
        email: true,
      }).refusals,
    ).toEqual([]);
    expect(
      planAddRecipients("QUARTERLY", ["c"], holders, new Set(), {
        email: false,
      }).refusals,
    ).toEqual([]);
  });

  it("on a K-1 report requires a K-1 attached for each new holder", () => {
    const k1 = [holder("a", { hasK1: true }), holder("b")];
    expect(
      planAddRecipients("TAX_K1", ["b"], k1, new Set()).refusals.map(
        (r) => r.code,
      ),
    ).toEqual(["K1_MISSING"]);
    expect(planAddRecipients("TAX_K1", ["a"], k1, new Set()).refusals).toEqual(
      [],
    );
  });

  it("warns about the default audience still left out and names only added unusual choices", () => {
    const plan = planAddRecipients("QUARTERLY", ["f"], holders, new Set(["a"]));
    expect(plan.warnings.map((w) => [w.code, w.stakeholderIds])).toEqual([
      ["MEMBERS_NOT_SELECTED", ["b", "c"]],
      ["NOT_MEMBERS_SELECTED", ["f"]],
      ["RECEIVES_NOTHING", ["f"]],
    ]);
    expect(plan.warnings[1]?.message).toBe(
      "1 selected holder is not a Member.",
    );
  });
});

function row(id: string, over: Partial<ResendRow> = {}): ResendRow {
  return {
    id,
    name: id.toUpperCase(),
    email: `${id}@example.com`,
    sendCount: 0,
    sentAt: null,
    tokenRevokedAt: null,
    ...over,
  };
}

describe("resendPlan", () => {
  const rows = [
    row("a", { sentAt: NOW, sendCount: 1 }),
    row("b"),
    row("c", { email: "  " }),
    row("d", { tokenRevokedAt: NOW }),
  ];

  it("ALL queues every recipient with an address and a live link", () => {
    const plan = resendPlan(rows, "ALL");
    expect(plan.queue.map((r) => r.id)).toEqual(["a", "b"]);
    expect(plan.skipped.map((s) => [s.row.id, s.reason])).toEqual([
      ["c", "NO_ADDRESS"],
      ["d", "LINK_REVOKED"],
    ]);
  });

  it("NOT_EMAILED leaves out recipients whose email was accepted", () => {
    const plan = resendPlan(rows, "NOT_EMAILED");
    expect(plan.queue.map((r) => r.id)).toEqual(["b"]);
    expect(plan.skipped.map((s) => s.row.id)).toEqual(["c", "d"]);
  });

  it("never queues a blank address", () => {
    for (const scope of ["ALL", "NOT_EMAILED"] as const) {
      expect(
        resendPlan(rows, scope).queue.every((r) => r.email.trim() !== ""),
      ).toBe(true);
    }
  });

  it("refuses one named recipient without an address, naming it", () => {
    expect(singleResendRefusal(row("c", { email: "" }))).toBe(
      "C has no email address. Replace the link with an address to email it.",
    );
    expect(singleResendRefusal(row("b"))).toBeNull();
    expect(singleResendRefusal(row("d", { tokenRevokedAt: NOW }))).toMatch(
      /revoked/,
    );
  });
});

describe("inviteTargets", () => {
  it("normalises, sorts by address then holder, and reports holders it cannot invite", () => {
    const { targets, skipped } = inviteTargets([
      { stakeholderId: "s2", name: "Two", noticeEmail: " Zed@Example.com " },
      { stakeholderId: "s1", name: "One", noticeEmail: "amy@example.com" },
      { stakeholderId: "s0", name: "Zero", noticeEmail: "amy@example.com" },
      { stakeholderId: "s3", name: "Three", noticeEmail: "" },
      { stakeholderId: "s4", name: "Four", noticeEmail: "not an address" },
    ]);
    expect(targets.map((t) => [t.stakeholderId, t.email])).toEqual([
      ["s0", "amy@example.com"],
      ["s1", "amy@example.com"],
      ["s2", "zed@example.com"],
    ]);
    expect(skipped.map((s) => [s.stakeholderId, s.reason])).toEqual([
      ["s3", "NO_ADDRESS"],
      ["s4", "INVALID_ADDRESS"],
    ]);
  });
});

describe("invitationEmailsToQueue", () => {
  it("keeps one email per address: the last one (its token is the live one)", () => {
    const out = invitationEmailsToQueue([
      { email: "amy@example.com", emailKind: "INVITE", tokenId: "t1" },
      { email: "zed@example.com", emailKind: null, tokenId: undefined },
      { email: "amy@example.com", emailKind: "INVITE", tokenId: "t2" },
      {
        email: "bob@example.com",
        emailKind: "ACCESS_ADDED",
        tokenId: undefined,
      },
    ]);
    expect(out.map((r) => [r.email, r.tokenId])).toEqual([
      ["amy@example.com", "t2"],
      ["bob@example.com", undefined],
    ]);
  });
});
