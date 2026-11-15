import { describe, expect, it } from "vitest";
import {
  type AddresseeAccess,
  addresseeAccess,
  linkShowsContent,
  type ReportLinkState,
  reportLinkState,
} from "./report-link-core";

const T = new Date("2026-11-01T00:00:00.000Z");
const T2 = new Date("2026-11-10T00:00:00.000Z");

describe("reportLinkState: the P25 table", () => {
  const ACCESSES: AddresseeAccess[] = ["NONE", "INVITED", "ACTIVE", "DISABLED"];

  it("unpublished, any access: WITHDRAWN", () => {
    for (const a of ACCESSES) {
      expect(
        reportLinkState({
          publishedAt: T,
          unpublishedAt: T2,
          addresseeAccess: a,
        }),
      ).toEqual({
        state: "WITHDRAWN",
        setupNeeded: false,
      });
    }
  });

  it("published, ACTIVE with a password: PORTAL, no set-up", () => {
    expect(
      reportLinkState({
        publishedAt: T,
        unpublishedAt: null,
        addresseeAccess: "ACTIVE",
      }),
    ).toEqual({ state: "PORTAL", setupNeeded: false });
  });

  it("published, ACTIVE without a password: PORTAL with set-up", () => {
    expect(
      reportLinkState({
        publishedAt: T,
        unpublishedAt: null,
        addresseeAccess: "INVITED",
      }),
    ).toEqual({ state: "PORTAL", setupNeeded: true });
  });

  it("published, DISABLED: ACCESS_OFF", () => {
    expect(
      reportLinkState({
        publishedAt: T,
        unpublishedAt: null,
        addresseeAccess: "DISABLED",
      }),
    ).toEqual({ state: "ACCESS_OFF", setupNeeded: false });
  });

  it("published, never invited at this address: LEGACY token page", () => {
    expect(
      reportLinkState({
        publishedAt: T,
        unpublishedAt: null,
        addresseeAccess: "NONE",
      }),
    ).toEqual({ state: "LEGACY", setupNeeded: false });
  });

  it("sent before the portal (never published), any access: LEGACY", () => {
    for (const a of ACCESSES) {
      expect(
        reportLinkState({
          publishedAt: null,
          unpublishedAt: null,
          addresseeAccess: a,
        }),
      ).toEqual({ state: "LEGACY", setupNeeded: false });
    }
  });

  it("all 16 combinations of the two dates and four accesses", () => {
    const expected = (
      pub: boolean,
      unpub: boolean,
      a: AddresseeAccess,
    ): ReportLinkState => {
      if (unpub) return "WITHDRAWN";
      if (!pub) return "LEGACY";
      return {
        NONE: "LEGACY",
        INVITED: "PORTAL",
        ACTIVE: "PORTAL",
        DISABLED: "ACCESS_OFF",
      }[a] as ReportLinkState;
    };
    let n = 0;
    for (const pub of [false, true]) {
      for (const unpub of [false, true]) {
        for (const a of ACCESSES) {
          const r = reportLinkState({
            publishedAt: pub ? T : null,
            unpublishedAt: unpub ? T2 : null,
            addresseeAccess: a,
          });
          expect(r.state).toBe(expected(pub, unpub, a));
          expect(r.setupNeeded).toBe(!unpub && pub && a === "INVITED");
          n++;
        }
      }
    }
    expect(n).toBe(16);
  });

  it("the inconsistent row (never published, unpublishedAt set) is WITHDRAWN, not LEGACY", () => {
    expect(
      reportLinkState({
        publishedAt: null,
        unpublishedAt: T2,
        addresseeAccess: "NONE",
      }).state,
    ).toBe("WITHDRAWN");
  });

  it("an unknown access value never reaches LEGACY", () => {
    for (const bad of ["", "active", "PENDING", undefined, null]) {
      const r = reportLinkState({
        publishedAt: T,
        unpublishedAt: null,
        addresseeAccess: bad as unknown as AddresseeAccess,
      });
      expect(r.state).toBe("ACCESS_OFF");
      expect(linkShowsContent(r.state)).toBe(false);
    }
  });

  it("only LEGACY shows report content (P26)", () => {
    expect(linkShowsContent("LEGACY")).toBe(true);
    expect(linkShowsContent("WITHDRAWN")).toBe(false);
    expect(linkShowsContent("PORTAL")).toBe(false);
    expect(linkShowsContent("ACCESS_OFF")).toBe(false);
  });
});

describe("addresseeAccess", () => {
  const holderAccesses = [
    { email: "investor@x.test", status: "ACTIVE" as const, passwordSet: true },
    {
      email: "accountant@y.test",
      status: "ACTIVE" as const,
      passwordSet: true,
    },
  ];

  it("matches the recipient address, normalised", () => {
    expect(addresseeAccess(holderAccesses, "investor@x.test")).toBe("ACTIVE");
    expect(addresseeAccess(holderAccesses, "  Investor@X.TEST ")).toBe(
      "ACTIVE",
    );
  });

  it("another person's access to the same holder does not count", () => {
    expect(addresseeAccess(holderAccesses, "spouse@x.test")).toBe("NONE");
    expect(addresseeAccess([], "investor@x.test")).toBe("NONE");
  });

  it("reports INVITED and DISABLED", () => {
    expect(
      addresseeAccess(
        [{ email: "a@x.test", status: "ACTIVE", passwordSet: false }],
        "a@x.test",
      ),
    ).toBe("INVITED");
    expect(
      addresseeAccess(
        [{ email: "a@x.test", status: "DISABLED", passwordSet: true }],
        "a@x.test",
      ),
    ).toBe("DISABLED");
  });

  it("a missing or malformed recipient address matches nothing", () => {
    expect(addresseeAccess(holderAccesses, null)).toBe("NONE");
    expect(addresseeAccess(holderAccesses, "")).toBe("NONE");
    expect(
      addresseeAccess(holderAccesses, "investor@x.test, accountant@y.test"),
    ).toBe("NONE");
  });

  it("does not match on a substring or a look-alike", () => {
    expect(addresseeAccess(holderAccesses, "vestor@x.test")).toBe("NONE");
    expect(addresseeAccess(holderAccesses, "investor@x.test.evil")).toBe(
      "NONE",
    );
  });

  it("if two rows ever match, DISABLED wins, then INVITED", () => {
    expect(
      addresseeAccess(
        [
          { email: "a@x.test", status: "ACTIVE", passwordSet: true },
          { email: "A@x.test", status: "DISABLED", passwordSet: true },
        ],
        "a@x.test",
      ),
    ).toBe("DISABLED");
    expect(
      addresseeAccess(
        [
          { email: "a@x.test", status: "ACTIVE", passwordSet: true },
          { email: "a@x.test", status: "ACTIVE", passwordSet: false },
        ],
        "a@x.test",
      ),
    ).toBe("INVITED");
  });
});
