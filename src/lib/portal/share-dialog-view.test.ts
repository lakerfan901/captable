import { describe, expect, it } from "vitest";
import {
  bulkPlan,
  candidateHolders,
  chunk,
  eventLabel,
  filterLogRows,
  filterPeople,
  initialTicks,
  memberFilterOptions,
  missingMembers,
  pendingRemovals,
  peopleByHolder,
  peopleStatusOf,
  portalTab,
  type ShareDocView,
  saveDiff,
  saveMessage,
  sharedWithLabel,
  shareNotices,
  showPresets,
} from "./share-dialog-view";

const at = new Date("2026-11-01T12:00:00Z");

function doc(id: string, over: Partial<ShareDocView> = {}): ShareDocView {
  return {
    documentPublicId: id,
    name: `${id}.pdf`,
    shareability: { kind: "ANY" },
    sharedWith: [],
    warnings: [],
    ...over,
  };
}

const holders = [
  { stakeholderId: "a", isCurrentMember: true },
  { stakeholderId: "b", isCurrentMember: true },
  { stakeholderId: "c", isCurrentMember: true },
  { stakeholderId: "p", isCurrentMember: false },
];

const w9 = doc("w9", {
  name: "W-9 — A",
  shareability: { kind: "HOLDER_ONLY", stakeholderId: "a", holderName: "A" },
});
const tiedTwice = doc("x", {
  shareability: { kind: "NONE", reason: "MULTIPLE_HOLDERS" },
  sharedWith: [{ stakeholderId: "b", name: "B", sharedAt: at }],
});
const oa = doc("oa", {
  sharedWith: [
    { stakeholderId: "a", name: "A", sharedAt: at },
    { stakeholderId: "b", name: "B", sharedAt: at },
  ],
});

describe("share dialog: who can be ticked", () => {
  it("a holder-bound document offers only its holder and no presets", () => {
    expect(
      candidateHolders(holders, [w9], true).map((h) => h.stakeholderId),
    ).toEqual(["a"]);
    expect(showPresets([w9])).toBe(false);
    expect(missingMembers(holders, [w9], new Set(), true).message).toBeNull();
  });

  it("a document shareable with nobody offers nobody", () => {
    expect(candidateHolders(holders, [tiedTwice], true)).toEqual([]);
    expect(showPresets([tiedTwice])).toBe(false);
  });

  it("an ordinary document and a bulk selection offer every holder", () => {
    expect(candidateHolders(holders, [oa], true)).toHaveLength(4);
    expect(candidateHolders(holders, [oa, w9], true)).toHaveLength(4);
    expect(showPresets([oa, w9])).toBe(true);
  });

  it("without delete, holders already on the list are not offered (they cannot be unticked)", () => {
    expect(
      candidateHolders(holders, [oa], false).map((h) => h.stakeholderId),
    ).toEqual(["c", "p"]);
    expect([...initialTicks([oa], false)]).toEqual([]);
  });

  it("opens one document with its saved list ticked, several with nothing", () => {
    expect([...initialTicks([oa], true)].sort()).toEqual(["a", "b"]);
    expect([...initialTicks([oa, w9], true)]).toEqual([]);
  });
});

describe("share dialog: missing current Members (P28)", () => {
  it("follows the ticks, not the saved list", () => {
    const m = missingMembers(holders, [oa], new Set(["a", "b"]), true);
    expect(m.stakeholderIds).toEqual(["c"]);
    expect(m.message).toBe("1 current Member is not on this list.");
    expect(missingMembers(holders, [oa], new Set(["a"]), true).message).toBe(
      "2 current Members are not on this list.",
    );
    expect(
      missingMembers(holders, [oa], new Set(["a", "b", "c"]), true).message,
    ).toBeNull();
  });

  it("counts the kept list when removals are not allowed", () => {
    expect(
      missingMembers(holders, [oa], new Set(), false).stakeholderIds,
    ).toEqual(["c"]);
  });

  it("prospects are never counted", () => {
    expect(
      missingMembers(holders, [oa], new Set(["a", "b", "c"]), true)
        .stakeholderIds,
    ).not.toContain("p");
  });
});

describe("share dialog: save", () => {
  it("one document: adds new ticks and removes unticked saved holders", () => {
    expect(saveDiff([oa], new Set(["b", "c"]), true)).toEqual({
      documentPublicIds: ["oa"],
      add: ["c"],
      remove: ["a"],
    });
    expect(pendingRemovals(oa, new Set(["b", "c"]), true)).toBe(1);
  });

  it("without delete nothing is removed", () => {
    expect(saveDiff([oa], new Set(["c"]), false)).toEqual({
      documentPublicIds: ["oa"],
      add: ["c"],
      remove: [],
    });
    expect(pendingRemovals(oa, new Set(), false)).toBe(0);
  });

  it("a document shareable with nobody can still have stale rows removed", () => {
    expect(saveDiff([tiedTwice], new Set(), true)).toEqual({
      documentPublicIds: [],
      add: [],
      remove: ["b"],
    });
  });

  it("bulk: ticks go to every unbound document; bound ones are left out", () => {
    const d2 = doc("d2");
    expect(
      bulkPlan([oa, w9, d2]).leftOut.map((d) => d.documentPublicId),
    ).toEqual(["w9"]);
    expect(saveDiff([oa, w9, d2], new Set(["c", "a"]), true)).toEqual({
      documentPublicIds: ["oa", "d2"],
      add: ["a", "c"],
      remove: [],
    });
    expect(saveDiff([w9, tiedTwice], new Set(["a"]), true).add).toEqual([]);
  });

  it("saved message reports the server's count of queued emails", () => {
    expect(
      saveMessage({
        added: 3,
        holdersAdded: 3,
        removed: 1,
        notify: false,
        notificationsQueued: 0,
      }),
    ).toBe("Sharing saved: 3 holders added, 1 removed.");
    expect(
      saveMessage({
        added: 1,
        holdersAdded: 1,
        removed: 0,
        notify: true,
        notificationsQueued: 2,
      }),
    ).toBe("Sharing saved: 1 holder added. 2 emails queued.");
    expect(
      saveMessage({
        added: 1,
        holdersAdded: 1,
        removed: 0,
        notify: true,
        notificationsQueued: 0,
      }),
    ).toContain("No email was queued");
  });
});

describe("share dialog: notices", () => {
  it("explains a holder-bound document and repeats the server's warnings", () => {
    const n = shareNotices([
      doc("w9", {
        shareability: {
          kind: "HOLDER_ONLY",
          stakeholderId: "a",
          holderName: "Alder",
        },
        warnings: [
          { code: "SIGNED_DOCUMENT", message: "This is a signed document." },
        ],
      }),
    ]);
    expect(n[0]?.text).toMatch(
      /belongs to Alder\. It can be shared only with that holder/,
    );
    expect(n[1]).toEqual({
      tone: "warning",
      text: "This is a signed document.",
    });
  });

  it("explains a document that can be shared with nobody", () => {
    expect(shareNotices([tiedTwice])[0]?.text).toMatch(/more than one holder/);
  });

  it("bulk names the documents left out and those that name other Members", () => {
    const ex = doc("exa", {
      name: "Exhibit A",
      warnings: [{ code: "MEMBER_LIST", message: "x" }],
    });
    const n = shareNotices([oa, w9, ex]);
    expect(n[0]?.text).toBe(
      "1 selected document belongs to one holder and is left out: W-9 — A. Share it from its own row.",
    );
    expect(n[1]).toEqual({
      tone: "warning",
      text: "1 selected document names other Members (Exhibit A). Check before you share.",
    });
  });
});

describe("people under each holder", () => {
  it("lists active and invited people once, sorted, and leaves out disabled ones", () => {
    const m = peopleByHolder([
      { stakeholderId: "a", email: "z@example.com", status: "ACTIVE" },
      { stakeholderId: "a", email: "b@example.com", status: "INVITED" },
      { stakeholderId: "a", email: "old@example.com", status: "DISABLED" },
      { stakeholderId: "b", email: "q@example.com", status: "DISABLED" },
    ]);
    expect(m.get("a")).toEqual([
      { email: "b@example.com", state: "INVITED" },
      { email: "z@example.com", state: "ACTIVE" },
    ]);
    expect(m.has("b")).toBe(false);
  });
});

describe("investor portal page", () => {
  const rows = [
    {
      holderName: "Alder",
      email: "dana@example.com",
      status: "ACTIVE" as const,
      locked: false,
    },
    {
      holderName: "Alder",
      email: "acct@example.com",
      status: "INVITED" as const,
      locked: false,
    },
    {
      holderName: "Bexley",
      email: "m@example.com",
      status: "ACTIVE" as const,
      locked: true,
    },
    {
      holderName: "Larkspur",
      email: "f@example.com",
      status: "DISABLED" as const,
      locked: true,
    },
  ];

  it("files a locked row under Locked and a disabled one under Disabled", () => {
    expect(rows.map(peopleStatusOf)).toEqual([
      "ACTIVE",
      "INVITED",
      "LOCKED",
      "DISABLED",
    ]);
  });

  it("filters by member or email and by status", () => {
    expect(filterPeople(rows, "alder", "ALL")).toHaveLength(2);
    expect(
      filterPeople(rows, "M@EXAMPLE", "ALL").map((r) => r.holderName),
    ).toEqual(["Bexley"]);
    expect(filterPeople(rows, "", "LOCKED").map((r) => r.holderName)).toEqual([
      "Bexley",
    ]);
    expect(filterPeople(rows, "alder", "INVITED")).toHaveLength(1);
  });

  it("labels events and filters loaded rows by item", () => {
    expect(eventLabel("DOCUMENT_OPENED")).toBe("Opened document");
    expect(eventLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    const log = [
      { id: 1, target: { name: "Operating Agreement.pdf" } },
      { id: 2, target: null },
      { id: 3, target: { name: null } },
    ];
    expect(filterLogRows(log, "operating").map((r) => r.id)).toEqual([1]);
    expect(filterLogRows(log, " ")).toHaveLength(3);
  });

  it("member filter options are unique and by name", () => {
    expect(
      memberFilterOptions([
        { stakeholderId: "2", holderName: "Bexley" },
        { stakeholderId: "1", holderName: "Alder" },
        { stakeholderId: "2", holderName: "Bexley" },
      ]),
    ).toEqual([
      { value: "1", label: "Alder" },
      { value: "2", label: "Bexley" },
    ]);
  });

  it("reads the tab from the URL", () => {
    expect(portalTab("activity")).toBe("activity");
    expect(portalTab(["activity"])).toBe("people");
    expect(portalTab(undefined)).toBe("people");
  });

  it("small helpers", () => {
    expect(sharedWithLabel(0)).toBe("—");
    expect(sharedWithLabel(1)).toBe("1 holder");
    expect(sharedWithLabel(4)).toBe("4 holders");
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
