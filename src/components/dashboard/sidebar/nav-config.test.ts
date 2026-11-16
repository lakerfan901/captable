import { describe, expect, it } from "vitest";
import {
  getCompanyNav,
  getNavSections,
  type NavSection,
  visibleCompanyNav,
  visibleNavSections,
} from "./nav-config";

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

  it("LLC lists Investor portal after Documents, behind the portal subject", () => {
    const communication = getNavSections("LLC").find(
      (s) => s.title === "Communication",
    );
    const names = communication?.items.map((i) => i.name) ?? [];
    expect(names.indexOf("Investor portal")).toBe(
      names.indexOf("Documents") + 1,
    );
    const item = communication?.items.find((i) => i.name === "Investor portal");
    expect(item).toMatchObject({
      href: "/investor-portal",
      subject: "portal",
      icon: "userShared",
    });
    const corp = getNavSections("CORPORATION").flatMap((s) => s.items);
    expect(corp.some((i) => i.href === "/investor-portal")).toBe(false);
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

  it("hides items and whole sections the user cannot read", () => {
    const only = (allowed: string[]) => (s: string) => allowed.includes(s);
    const none = visibleNavSections(getNavSections("LLC"), only([]));
    expect(allHrefs(none)).toEqual(["/", "/updates"]);
    const gov = visibleNavSections(getNavSections("LLC"), only(["governance"]));
    expect(gov.map((s) => s.title)).toEqual([
      undefined,
      "Governance",
      "Communication",
    ]);
    expect(allHrefs(gov)).toContain("/resolutions");
    expect(allHrefs(gov)).not.toContain("/commitments");
    expect(allHrefs(gov)).not.toContain("/investor-portal");
    expect(visibleCompanyNav(getCompanyNav("LLC"), only([]))).toEqual([]);
    const portal = visibleNavSections(getNavSections("LLC"), only(["portal"]));
    expect(allHrefs(portal)).toEqual(["/", "/investor-portal", "/updates"]);
    const all = visibleNavSections(getNavSections("LLC"), () => true);
    expect(all).toEqual(getNavSections("LLC"));
  });
});
