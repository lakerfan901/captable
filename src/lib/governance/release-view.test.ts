import { describe, expect, it } from "vitest";
import {
  addButtonLabel,
  addReview,
  applyPreset,
  deliveryPlan,
  emailsSentence,
  filterHolders,
  holdersToInvite,
  initialSelection,
  invitationEmailCount,
  mayEmail,
  type PickerHolder,
  pickerCandidates,
  publishState,
  type RecipientFacts,
  recipientActions,
  releaseButtonLabel,
  releasedLine,
  releaseReview,
  replaceLinkEmailCount,
  reportChip,
  resendRound,
  unitsText,
} from "./release-view";

function holder(id: string, over: Partial<PickerHolder> = {}): PickerHolder {
  return {
    stakeholderId: id,
    name: `${id} Holder`,
    memberStatus: "MEMBER",
    preferredUnits: "100.000000",
    commonUnits: "0.000000",
    noticeEmail: `${id.toLowerCase()}@example.com`,
    hasK1: false,
    isRecipient: false,
    portal: "ACTIVE",
    noticeAddressAccess: "ACTIVE",
    transferor: false,
    ...over,
  };
}

const A = holder("A");
const B = holder("B", { noticeAddressAccess: "NONE", portal: "NONE" });
const C = holder("C", {
  noticeAddressAccess: "DISABLED",
  commonUnits: "50.000000",
});
const F = holder("F", {
  memberStatus: "FINANCIAL_INTEREST_ONLY",
  preferredUnits: "0.000000",
  noticeAddressAccess: "NONE",
  portal: "NONE",
});
const ALL = [A, B, C, F];
const fmt = (d: string) => `<${d}>`;

describe("pickerCandidates / initialSelection / applyPreset", () => {
  it("TAX_K1 lists only holders with a K-1; ADD hides recipients", () => {
    const hs = [
      holder("A", { hasK1: true }),
      holder("B"),
      holder("C", { hasK1: true, isRecipient: true }),
    ];
    expect(
      pickerCandidates("TAX_K1", hs, "RELEASE").map((h) => h.stakeholderId),
    ).toEqual(["A", "C"]);
    expect(
      pickerCandidates("TAX_K1", hs, "ADD").map((h) => h.stakeholderId),
    ).toEqual(["A"]);
    expect(
      pickerCandidates("QUARTERLY", hs, "ADD").map((h) => h.stakeholderId),
    ).toEqual(["A", "B"]);
  });

  it("release opens with the default preset; add opens empty except on a K-1 report", () => {
    const presets = [
      { key: "ALL_CURRENT_MEMBERS", stakeholderIds: ["A", "B", "X"] },
      { key: "PREFERRED_MEMBERS", stakeholderIds: ["A"] },
    ];
    expect([
      ...initialSelection(
        "QUARTERLY",
        "RELEASE",
        [A, B],
        presets,
        "ALL_CURRENT_MEMBERS",
      ),
    ]).toEqual(["A", "B"]);
    expect(
      initialSelection("QUARTERLY", "RELEASE", [A], presets, null).size,
    ).toBe(0);
    expect(
      initialSelection(
        "QUARTERLY",
        "ADD",
        [A, B],
        presets,
        "ALL_CURRENT_MEMBERS",
      ).size,
    ).toBe(0);
    expect([
      ...initialSelection("TAX_K1", "ADD", [A, B], [], "K1_ATTACHED"),
    ]).toEqual(["A", "B"]);
  });

  it("a preset ticks only listed holders; Clear ticks none", () => {
    expect([...applyPreset([A, B], ["B", "Z"])]).toEqual(["B"]);
    expect(applyPreset([A, B], null).size).toBe(0);
  });
});

describe("filterHolders / unitsText", () => {
  it("matches name or notice address, case-insensitive", () => {
    expect(filterHolders(ALL, "  b HOLD ").map((h) => h.stakeholderId)).toEqual(
      ["B"],
    );
    expect(filterHolders(ALL, "f@EXAMPLE").map((h) => h.stakeholderId)).toEqual(
      ["F"],
    );
    expect(filterHolders(ALL, "").length).toBe(4);
  });

  it("formats units", () => {
    expect(
      unitsText({ preferredUnits: "1234.500000", commonUnits: "0.000000" }),
    ).toBe("Preferred · 1,234.5 units");
    expect(unitsText({ preferredUnits: "0", commonUnits: "1.000000" })).toBe(
      "Common · 1 unit",
    );
    expect(unitsText({ preferredUnits: "10", commonUnits: "2" })).toBe(
      "Preferred · 10 units, Common · 2 units",
    );
    expect(
      unitsText({ preferredUnits: "0.000000", commonUnits: "0.000000" }),
    ).toBe("No units");
  });
});

describe("invitations (P27)", () => {
  it("lists holders whose notice address has no access, with an address", () => {
    const noAddress = holder("N", {
      noticeAddressAccess: "NONE",
      noticeEmail: "",
    });
    const invalid = holder("I", {
      noticeAddressAccess: "NONE",
      noticeEmail: "not an address",
    });
    expect(
      holdersToInvite([A, B, C, F, noAddress, invalid]).map(
        (h) => h.stakeholderId,
      ),
    ).toEqual(["B", "F"]);
  });

  it("one invitation email per person", () => {
    const twoTrusts = [
      holder("T1", {
        noticeAddressAccess: "NONE",
        noticeEmail: "Same@Example.com",
      }),
      holder("T2", {
        noticeAddressAccess: "NONE",
        noticeEmail: "same@example.com ",
      }),
      B,
    ];
    expect(invitationEmailCount(twoTrusts)).toBe(2);
  });

  it("the line exists only with email ticked and the permission", () => {
    expect(
      deliveryPlan([A, B, F], { email: true, invite: true, mayInvite: true }),
    ).toMatchObject({
      reportEmails: 3,
      invitationEmails: 2,
      inviteMissing: true,
    });
    const noPerm = deliveryPlan([A, B], {
      email: true,
      invite: true,
      mayInvite: false,
    });
    expect(noPerm.inviteLine).toEqual([]);
    expect(noPerm.inviteMissing).toBe(false);
    const portalOnly = deliveryPlan([A, B], {
      email: false,
      invite: true,
      mayInvite: true,
    });
    expect(portalOnly).toMatchObject({
      reportEmails: 0,
      invitationEmails: 0,
      inviteMissing: false,
    });
    const unticked = deliveryPlan([A, B], {
      email: true,
      invite: false,
      mayInvite: true,
    });
    expect(unticked.inviteLine.map((h) => h.stakeholderId)).toEqual(["B"]);
    expect(unticked).toMatchObject({
      invitationEmails: 0,
      inviteMissing: false,
    });
    const nobody = deliveryPlan([A, C], {
      email: true,
      invite: true,
      mayInvite: true,
    });
    expect(nobody.inviteMissing).toBe(false);
  });
});

describe("email counts and button labels", () => {
  it("states every email that goes out", () => {
    expect(emailsSentence({ reportEmails: 4, invitationEmails: 2 })).toBe(
      "4 report emails and 2 portal invitations",
    );
    expect(emailsSentence({ reportEmails: 1, invitationEmails: 0 })).toBe(
      "1 report email",
    );
    expect(emailsSentence({ reportEmails: 0, invitationEmails: 0 })).toBeNull();
    expect(releaseButtonLabel(3, 0)).toBe("Release to 3 holders");
    expect(releaseButtonLabel(1, 2)).toBe(
      "Release to 1 holder and send 2 emails",
    );
    expect(addButtonLabel(1, 1)).toBe("Add 1 recipient and send 1 email");
    expect(addButtonLabel(2, 0)).toBe("Add 2 recipients");
  });
});

describe("releaseReview", () => {
  const facts = {
    type: "QUARTERLY" as const,
    noticeKind: null,
    periodEnd: "2026-09-30",
    hasDeadline: true,
  };

  it("all current Members with email: books closed, deadline done", () => {
    const r = releaseReview(facts, {
      holders: ALL,
      selectedIds: ["A", "B", "C"],
      email: true,
      deadlineAudienceIds: ["A", "B", "C"],
      formatDate: fmt,
    });
    expect(r.warnings).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.consequences[0]).toContain("Books closed through <2026-09-30>");
    expect(
      r.consequences.some((c) => /deadline/i.test(c) && /stays open/.test(c)),
    ).toBe(false);
    expect(r.consequences.at(-1)).toMatch(/content is frozen/);
  });

  it("portal only: deadline stays open; holders without access receive nothing", () => {
    const r = releaseReview(facts, {
      holders: ALL,
      selectedIds: ["A", "B"],
      email: false,
      deadlineAudienceIds: ["A", "B", "C"],
      formatDate: fmt,
    });
    expect(r.warnings.map((w) => w.code)).toEqual(["MEMBERS_NOT_SELECTED"]);
    expect(r.consequences.join(" ")).toContain(
      "stays open because the report is not emailed",
    );
    expect(r.consequences.join(" ")).toContain(
      "1 selected holder has no portal access and will not be emailed: they will receive nothing.",
    );
  });

  it("a non-Member is a warning; a missing notice address with email is a problem", () => {
    const noMail = holder("M", { noticeEmail: "" });
    const r = releaseReview(
      { ...facts, hasDeadline: false, periodEnd: null },
      {
        holders: [...ALL, noMail],
        selectedIds: ["A", "B", "C", "F", "M"],
        email: true,
        deadlineAudienceIds: [],
        formatDate: fmt,
      },
    );
    expect(r.warnings.map((w) => w.code)).toEqual(["NOT_MEMBERS_SELECTED"]);
    expect(r.problems).toEqual([
      'M Holder has no notice email: untick "Also send by email" or the holder.',
    ]);
    expect(r.consequences).toEqual([
      "The content is frozen. Holders not selected never see this report.",
    ]);
  });

  it("nothing selected is not a listed problem (the button says so)", () => {
    const r = releaseReview(facts, {
      holders: ALL,
      selectedIds: [],
      email: true,
      deadlineAudienceIds: ["A"],
      formatDate: fmt,
    });
    expect(r.problems).toEqual([]);
  });
});

describe("addReview", () => {
  it("names unusual additions and never promises a deadline", () => {
    const r = addReview(
      { type: "QUARTERLY", noticeKind: null },
      { holders: ALL, selectedIds: ["F"], email: false },
    );
    expect(r.warnings.map((w) => w.code)).toEqual(["NOT_MEMBERS_SELECTED"]);
    expect(r.consequences.join(" ")).toContain("will receive nothing");
    expect(r.consequences.at(-1)).toContain("closes no compliance deadline");
  });
});

describe("report page", () => {
  it("publish state and chip", () => {
    const at = new Date("2026-11-01T00:00:00Z");
    expect(
      publishState({ status: "DRAFT", publishedAt: null, unpublishedAt: null }),
    ).toBe("DRAFT");
    expect(
      publishState({ status: "SENT", publishedAt: at, unpublishedAt: null }),
    ).toBe("PUBLISHED");
    expect(
      publishState({ status: "SENT", publishedAt: at, unpublishedAt: at }),
    ).toBe("UNPUBLISHED");
    expect(
      publishState({ status: "SENT", publishedAt: null, unpublishedAt: null }),
    ).toBe("NEVER");
    expect(
      reportChip({ status: "SENT", publishedAt: at, unpublishedAt: at }).label,
    ).toBe("Unpublished");
    expect(
      reportChip({ status: "SENT", publishedAt: null, unpublishedAt: null })
        .label,
    ).toBe("Released");
    expect(
      reportChip({ status: "DRAFT", publishedAt: null, unpublishedAt: null })
        .label,
    ).toBe("Draft");
    expect(mayEmail("UNPUBLISHED")).toBe(false);
    expect(mayEmail("NEVER")).toBe(true);
  });

  it("released line says whether it was emailed", () => {
    expect(releasedLine("Nov 1", 2, 3)).toBe(
      "Released Nov 1 · emailed to 2 of 3",
    );
    expect(releasedLine("Nov 1", 0, 3)).toBe("Released Nov 1 · not emailed");
  });

  const r = (over: Partial<RecipientFacts>): RecipientFacts => ({
    id: "r",
    name: "A Holder",
    email: "a@example.com",
    sendCount: 0,
    emailedAt: null,
    linkState: "ACTIVE",
    canRemove: true,
    ...over,
  });

  it("row actions follow the server's rules and are absent otherwise", () => {
    const pub = { canUpdate: true, state: "PUBLISHED" as const };
    expect(recipientActions(r({}), pub)).toEqual({
      email: "Email",
      replaceLink: true,
      remove: true,
    });
    expect(
      recipientActions(
        r({ emailedAt: "2026-11-01", sendCount: 1, canRemove: false }),
        pub,
      ),
    ).toEqual({
      email: "Resend",
      replaceLink: true,
      remove: false,
    });
    expect(recipientActions(r({ email: "" }), pub).email).toBeNull();
    expect(recipientActions(r({ linkState: "REVOKED" }), pub).email).toBeNull();
    expect(
      recipientActions(r({}), { canUpdate: true, state: "UNPUBLISHED" }),
    ).toEqual({
      email: null,
      replaceLink: false,
      remove: true,
    });
    expect(recipientActions(r({}), { ...pub, mailBlocked: true })).toEqual({
      email: null,
      replaceLink: false,
      remove: true,
    });
    expect(
      recipientActions(r({}), { canUpdate: false, state: "PUBLISHED" }),
    ).toEqual({
      email: null,
      replaceLink: false,
      remove: false,
    });
  });

  it("resend rounds count what is really queued and name the skipped", () => {
    const rows = [
      r({ id: "1", name: "Emailed", emailedAt: "2026-11-01", sendCount: 1 }),
      r({ id: "2", name: "Fresh" }),
      r({ id: "3", name: "Blank", email: "" }),
      r({
        id: "4",
        name: "Revoked",
        linkState: "REVOKED",
        emailedAt: "2026-11-01",
      }),
    ];
    expect(resendRound(rows, "ALL")).toEqual({
      queued: 2,
      skipped: [
        { name: "Blank", reason: "NO_ADDRESS" },
        { name: "Revoked", reason: "LINK_REVOKED" },
      ],
    });
    expect(resendRound(rows, "NOT_EMAILED")).toEqual({
      queued: 1,
      skipped: [{ name: "Blank", reason: "NO_ADDRESS" }],
    });
  });

  it("replace link: the new link plus one notice per other address", () => {
    expect(
      replaceLinkEmailCount({
        currentEmail: "a@example.com",
        newEmail: "",
        noticeEmail: "n@example.com",
      }),
    ).toEqual({ total: 1, notices: 0 });
    expect(
      replaceLinkEmailCount({
        currentEmail: "a@example.com",
        newEmail: "A@example.com",
        noticeEmail: "n@example.com",
      }),
    ).toEqual({ total: 1, notices: 0 });
    expect(
      replaceLinkEmailCount({
        currentEmail: "a@example.com",
        newEmail: "b@example.com",
        noticeEmail: "n@example.com",
      }),
    ).toEqual({ total: 3, notices: 2 });
    expect(
      replaceLinkEmailCount({
        currentEmail: "a@example.com",
        newEmail: "b@example.com",
        noticeEmail: "A@example.com",
      }),
    ).toEqual({ total: 2, notices: 1 });
    expect(
      replaceLinkEmailCount({
        currentEmail: "",
        newEmail: "b@example.com",
        noticeEmail: null,
      }),
    ).toEqual({ total: 1, notices: 0 });
  });
});
