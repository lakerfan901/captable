import { describe, expect, it } from "vitest";
import { getCompanyNav, getNavSections, type NavSection } from "./nav-config";

function allHrefs(sections: NavSection[]): string[] {
  return sections.flatMap((s) =>
    s.items.flatMap((item) =>
      item.subNav
        ? item.subNav.map((sub) => item.href + sub.href)
        : [item.href],
    ),
  );
}

describe("nav-config", () => {
  it("LLC sections contain no C-corp routes", () => {
    const hrefs = allHrefs(getNavSections("LLC"));
    for (const corp of [
      "/share-classes",
      "/equity-plans",
      "/securities",
      "/fundraise",
    ]) {
      expect(hrefs.some((h) => h.startsWith(corp))).toBe(false);
    }
  });

  it("LLC company nav has no Form 3921 or 409A", () => {
    const hrefs = getCompanyNav("LLC").map((i) => i.href);
    expect(hrefs).not.toContain("/3921");
    expect(hrefs).not.toContain("/409a");
    expect(getCompanyNav("LLC").map((i) => i.name)).toEqual([
      "Team",
      "Settings",
    ]);
  });

  it("every LLC href is unique", () => {
    const hrefs = allHrefs(getNavSections("LLC"));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("CORPORATION navigation is unchanged", () => {
    const sections = getNavSections("CORPORATION");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items.map((i) => i.name)).toEqual([
      "Overview",
      "Cap table",
      "Stakeholders",
      "Share classes",
      "Equity plans",
      "Securities",
      "Fundraise",
      "Documents",
      "Updates",
      "Reports",
      "Audits",
    ]);
    expect(getCompanyNav("CORPORATION").map((i) => i.href)).toEqual([
      "/settings/team",
      "/settings/company",
      "/3921",
      "/409a",
    ]);
  });
});
