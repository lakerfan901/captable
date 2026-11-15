import { describe, expect, it } from "vitest";
import {
  activeNavKey,
  companyInitials,
  holderOptionLabel,
  PORTAL_SECTIONS,
  type PortalSection,
  portalNavItems,
  switchTargetPath,
} from "./portal-nav";

const ALL_BUILT: PortalSection[] = PORTAL_SECTIONS.map((s) => ({
  ...s,
  built: true,
}));

describe("portalNavItems", () => {
  it("lists only sections whose page exists", () => {
    const items = portalNavItems("acc_12345678");
    expect(items.map((i) => i.key)).toEqual(
      PORTAL_SECTIONS.filter((s) => s.built).map((s) => s.key),
    );
    for (const item of items) {
      expect(item.href.startsWith("/portal/acc_12345678")).toBe(true);
    }
  });

  it("keeps the plan's tab order and hides what the caller hides", () => {
    const items = portalNavItems("a1b2c3d4e5", {
      sections: ALL_BUILT,
      hide: ["financials", "investment"],
    });
    expect(items).toEqual([
      { key: "overview", label: "Overview", href: "/portal/a1b2c3d4e5" },
      { key: "reports", label: "Reports", href: "/portal/a1b2c3d4e5/reports" },
      {
        key: "documents",
        label: "Documents",
        href: "/portal/a1b2c3d4e5/documents",
      },
    ]);
  });

  it("has the five sections of 6.3 in order", () => {
    expect(PORTAL_SECTIONS.map((s) => s.label)).toEqual([
      "Overview",
      "Financials",
      "My investment",
      "Reports",
      "Documents",
    ]);
  });

  it("encodes the access segment", () => {
    expect(portalNavItems("a/b")[0]?.href).toBe("/portal/a%2Fb");
  });
});

describe("activeNavKey", () => {
  const items = portalNavItems("acc1acc1", { sections: ALL_BUILT });
  it("matches the Overview only on its own path", () => {
    expect(activeNavKey("/portal/acc1acc1", items)).toBe("overview");
  });
  it("matches a section and its sub-pages", () => {
    expect(activeNavKey("/portal/acc1acc1/reports", items)).toBe("reports");
    expect(activeNavKey("/portal/acc1acc1/reports/r1", items)).toBe("reports");
  });
  it("matches nothing for another access or a lookalike path", () => {
    expect(activeNavKey("/portal/acc2acc2/reports", items)).toBeNull();
    expect(activeNavKey("/portal/acc1acc1x", items)).toBeNull();
    expect(activeNavKey("/portal/account", items)).toBeNull();
  });
});

describe("switchTargetPath", () => {
  it("keeps a built section", () => {
    expect(
      switchTargetPath(
        "/portal/aaaa1111/reports",
        "aaaa1111",
        "bbbb2222",
        ALL_BUILT,
      ),
    ).toBe("/portal/bbbb2222/reports");
  });
  it("drops a report or document id (it belongs to the other holder)", () => {
    expect(
      switchTargetPath(
        "/portal/aaaa1111/reports/rep_1",
        "aaaa1111",
        "bbbb2222",
        ALL_BUILT,
      ),
    ).toBe("/portal/bbbb2222/reports");
  });
  it("goes to the Overview from the Overview, an unknown or an unbuilt section", () => {
    expect(switchTargetPath("/portal/aaaa1111", "aaaa1111", "bbbb2222")).toBe(
      "/portal/bbbb2222",
    );
    expect(
      switchTargetPath("/portal/aaaa1111/whatever", "aaaa1111", "bbbb2222"),
    ).toBe("/portal/bbbb2222");
    expect(
      switchTargetPath(
        "/portal/aaaa1111/documents",
        "aaaa1111",
        "bbbb2222",
        PORTAL_SECTIONS.map((s) => ({ ...s, built: s.key === "overview" })),
      ),
    ).toBe("/portal/bbbb2222");
  });
  it("goes to the Overview when the path is not under the current access", () => {
    expect(
      switchTargetPath(
        "/portal/cccc3333/reports",
        "aaaa1111",
        "bbbb2222",
        ALL_BUILT,
      ),
    ).toBe("/portal/bbbb2222");
    expect(
      switchTargetPath(
        "/portal/aaaa1111x/reports",
        "aaaa1111",
        "bbbb2222",
        ALL_BUILT,
      ),
    ).toBe("/portal/bbbb2222");
  });
  it("never builds a path outside /portal/", () => {
    expect(
      switchTargetPath("//evil.example/x", "aaaa1111", "../../login"),
    ).toBe("/portal/..%2F..%2Flogin");
  });
});

describe("holderOptionLabel", () => {
  const a = {
    access: "1",
    holderName: "Family Trust",
    companyName: "Fund I LLC",
  };
  const b = {
    access: "2",
    holderName: "Kids Trust",
    companyName: "Fund I LLC",
  };
  const c = {
    access: "3",
    holderName: "Family Trust",
    companyName: "Fund II LLC",
  };
  it("names only the holder when every access is in one company", () => {
    expect(holderOptionLabel(a, [a, b])).toBe("Family Trust");
  });
  it("adds the company when accesses span companies", () => {
    expect(holderOptionLabel(a, [a, b, c])).toBe("Family Trust — Fund I LLC");
    expect(holderOptionLabel(c, [a, b, c])).toBe("Family Trust — Fund II LLC");
  });
});

describe("companyInitials", () => {
  it("takes two letters and skips the legal form", () => {
    expect(companyInitials("Northgate Compute I LLC")).toBe("NC");
    expect(companyInitials("Acme, LLC")).toBe("A");
    expect(companyInitials("")).toBe("?");
  });
});
