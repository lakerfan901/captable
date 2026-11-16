// Navigation of one holder's portal area (04-investor-portal.md 6.1, 6.3;
// package P8a). Pure, no imports: used by server pages and client
// components alike, and testable without the `@/` alias.
//
// Every page under `/portal/[access]` is addressed by the opaque
// `PortalAccess.publicId` (S25). It identifies, it does not authorize: the
// server resolves it against the signed-in portal user on every request.

/** The holder sections of 6.3, in the order of the tab row. */
export type PortalSectionKey =
  | "overview"
  | "financials"
  | "investment"
  | "reports"
  | "documents";

export interface PortalSection {
  key: PortalSectionKey;
  label: string;
  /** Path below `/portal/[access]`; "" for the Overview. */
  path: "" | `/${string}`;
  /**
   * The package that builds the page. A section appears in the navigation
   * only once its page exists: nothing is shown as a dead link or greyed out
   * (the owner's standing rule). The package that adds the page flips
   * `built` to true here.
   */
  owner: "P8a" | "P8b" | "P15";
  built: boolean;
}

export const PORTAL_SECTIONS: readonly PortalSection[] = [
  { key: "overview", label: "Overview", path: "", owner: "P8a", built: true },
  {
    key: "financials",
    label: "Financials",
    path: "/financials",
    owner: "P15",
    built: true,
  },
  {
    key: "investment",
    label: "My investment",
    path: "/investment",
    owner: "P15",
    built: true,
  },
  {
    key: "reports",
    label: "Reports",
    path: "/reports",
    owner: "P8b",
    built: false,
  },
  {
    key: "documents",
    label: "Documents",
    path: "/documents",
    owner: "P8b",
    built: false,
  },
];

export interface PortalNavItem {
  key: PortalSectionKey;
  label: string;
  href: string;
}

/** The base path of one access. */
export function accessBasePath(access: string): string {
  return `/portal/${encodeURIComponent(access)}`;
}

/**
 * The tab row for one access: the built sections, minus any the caller hides
 * for this holder (P15 hides Financials and My investment for a holder with
 * no published period, 6.3). Fewer than two items means no tab row at all.
 */
export function portalNavItems(
  access: string,
  options: {
    hide?: readonly PortalSectionKey[];
    sections?: readonly PortalSection[];
  } = {},
): PortalNavItem[] {
  const base = accessBasePath(access);
  const hide = new Set(options.hide ?? []);
  return (options.sections ?? PORTAL_SECTIONS)
    .filter((s) => s.built && !hide.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, href: `${base}${s.path}` }));
}

/**
 * The nav item a pathname belongs to: the longest href that equals the path
 * or is a parent of it (`/reports/abc` belongs to Reports), else null.
 */
export function activeNavKey(
  pathname: string,
  items: readonly PortalNavItem[],
): PortalSectionKey | null {
  let best: PortalNavItem | null = null;
  for (const item of items) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (best === null || item.href.length > best.href.length) best = item;
    }
  }
  return best?.key ?? null;
}

/**
 * Where the "Viewing" switcher goes for another access: the same section
 * of the other holder, never a deeper page (a report or document id belongs
 * to the holder it was opened for), and never anything outside the known
 * sections (the Overview then).
 */
export function switchTargetPath(
  pathname: string,
  fromAccess: string,
  toAccess: string,
  sections: readonly PortalSection[] = PORTAL_SECTIONS,
): string {
  const target = accessBasePath(toAccess);
  const from = accessBasePath(fromAccess);
  if (pathname !== from && !pathname.startsWith(`${from}/`)) return target;
  const rest = pathname.slice(from.length);
  const section = sections.find(
    (s) => s.path !== "" && (rest === s.path || rest.startsWith(`${s.path}/`)),
  );
  return section?.built ? `${target}${section.path}` : target;
}

export interface PortalHolderOption {
  access: string;
  holderName: string;
  companyName: string;
}

/**
 * The label of a holder in the chooser and the switcher. The company is
 * named only when the person's accesses span more than one company; with one
 * company it is already in the holder header.
 */
export function holderOptionLabel(
  holder: PortalHolderOption,
  all: readonly PortalHolderOption[],
): string {
  const companies = new Set(all.map((h) => h.companyName));
  return companies.size > 1
    ? `${holder.holderName} — ${holder.companyName}`
    : holder.holderName;
}

/** Initials for a company without a logo: two letters at most. */
export function companyInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^(llc|inc|ltd|lp|l\.?l\.?c\.?)$/i.test(w));
  const letters = words.slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}
