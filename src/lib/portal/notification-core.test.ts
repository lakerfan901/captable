import { describe, expect, it } from "vitest";
import { generatePublicId } from "../../common/id";
import { safeNextPath } from "./next-path";
import {
  DOCUMENTS_SHARED_KIND,
  documentCountPhrase,
  documentsSharedSubject,
  documentsSignInUrl,
  gainedByHolder,
  logStakeholderId,
  type NotificationAccess,
  notificationRecipients,
  notificationSingletonKey,
} from "./notification-core";

const acc = (
  portalUserId: string,
  stakeholderId: string,
  over: Partial<NotificationAccess> = {},
): NotificationAccess => ({
  portalUserId,
  stakeholderId,
  status: "ACTIVE",
  passwordSet: true,
  ...over,
});

describe("notificationRecipients", () => {
  it("one entry per person, listing only the affected holders they may be told about", () => {
    const r = notificationRecipients(
      [
        acc("u1", "A"),
        acc("u1", "B"),
        acc("u1", "X"), // not affected
        acc("u2", "B"),
        acc("u3", "C", { status: "DISABLED" }),
        acc("u4", "A", { passwordSet: false }),
        acc("u5", "X"),
      ],
      ["A", "B", "C"],
    );
    expect([...r.entries()]).toEqual([
      ["u1", ["A", "B"]],
      ["u2", ["B"]],
    ]);
  });

  it("a person with two accesses to affected holders is one entry", () => {
    const r = notificationRecipients(
      [acc("u1", "B"), acc("u1", "A"), acc("u1", "A")],
      new Set(["A", "B"]),
    );
    expect(r.size).toBe(1);
    expect(r.get("u1")).toEqual(["A", "B"]);
  });

  it("nobody when no holder gained anything", () => {
    expect(notificationRecipients([acc("u1", "A")], []).size).toBe(0);
  });
});

describe("gainedByHolder", () => {
  it("maps each holder to the documents it gained; holders that gained nothing are absent", () => {
    const g = gainedByHolder([
      { documentPublicId: "d2", addedStakeholderIds: ["B", "A"] },
      { documentPublicId: "d1", addedStakeholderIds: ["A"] },
      { documentPublicId: "d3", addedStakeholderIds: [] },
    ]);
    expect([...g.entries()]).toEqual([
      ["A", ["d1", "d2"]],
      ["B", ["d2"]],
    ]);
  });
});

describe("documentsSignInUrl", () => {
  it("one holder: sign-in with next to that holder's documents page, through safeNextPath", () => {
    const id = generatePublicId();
    const next = `/portal/${id}/documents`;
    expect(safeNextPath(next)).toBe(next);
    const url = documentsSignInUrl("http://localhost:3000/", [id]);
    expect(url).toBe(
      `http://localhost:3000/portal/sign-in?next=${encodeURIComponent(next)}`,
    );
    expect(new URL(url).searchParams.get("next")).toBe(next);
  });

  it("several holders: the plain sign-in page (the chooser follows)", () => {
    expect(documentsSignInUrl("https://x.test", ["a1", "b2"])).toBe(
      "https://x.test/portal/sign-in",
    );
  });

  it("an id safeNextPath refuses gives no next at all", () => {
    expect(documentsSignInUrl("https://x.test", ["../evil"])).toBe(
      "https://x.test/portal/sign-in",
    );
    expect(documentsSignInUrl("https://x.test", ["sign-in"])).toBe(
      "https://x.test/portal/sign-in",
    );
  });
});

describe("wording", () => {
  it("subject names the company only", () => {
    expect(documentsSharedSubject("Example Compute LLC")).toBe(
      "New documents in the Example Compute LLC investor portal",
    );
    expect(documentsSharedSubject(null)).toBe(
      "New documents in the investor portal",
    );
  });

  it("counts", () => {
    expect(documentCountPhrase(1)).toBe("1 new document");
    expect(documentCountPhrase(20)).toBe("20 new documents");
  });

  it("kind, log holder and singleton key", () => {
    expect(DOCUMENTS_SHARED_KIND).toBe("portal.documents-shared");
    expect(logStakeholderId(["c", "a", "b"])).toBe("a");
    expect(() => logStakeholderId([])).toThrow();
    expect(notificationSingletonKey("n1")).toBe("portal-notification-n1");
  });
});
