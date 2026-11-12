// Pure navigation config. Icons are referenced by key so this module has no
// React or icon imports (it is unit-tested with relative imports only).

export type EntityType = "CORPORATION" | "LLC";

export type NavIconKey =
  | "home"
  | "pieChart"
  | "group"
  | "folderChart2"
  | "safe"
  | "money"
  | "folder"
  | "mailSend"
  | "folderChart"
  | "list"
  | "equalizer"
  | "fileText";

export type NavSubItem = { name: string; href: string };

export type NavItem = {
  name: string;
  href: string;
  icon: NavIconKey;
  subNav?: NavSubItem[];
};

export type NavSection = { title?: string; items: NavItem[] };

export type CompanyNavItem = {
  id: number;
  name: string;
  href: string;
  rootPath?: string;
  icon: NavIconKey;
};

const documentsSubNav: NavSubItem[] = [
  { name: "Data rooms", href: "/data-rooms" },
  { name: "eSign documents", href: "/esign" },
  { name: "All documents", href: "/" },
];

const corporationNavigation: NavItem[] = [
  { name: "Overview", href: "/", icon: "home" },
  { name: "Cap table", href: "/captable", icon: "pieChart" },
  { name: "Stakeholders", href: "/stakeholders", icon: "group" },
  { name: "Share classes", href: "/share-classes", icon: "folderChart2" },
  { name: "Equity plans", href: "/equity-plans", icon: "folderChart2" },
  {
    name: "Securities",
    href: "/securities",
    icon: "safe",
    subNav: [
      { name: "Shares", href: "/shares" },
      { name: "Stock options", href: "/options" },
      { name: "Transactions", href: "/transactions" },
    ],
  },
  {
    name: "Fundraise",
    href: "/fundraise",
    icon: "money",
    subNav: [
      { name: "SAFEs", href: "/safes" },
      { name: "Convertible notes", href: "/convertible-notes" },
      { name: "Investments", href: "/investments" },
    ],
  },
  {
    name: "Documents",
    href: "/documents",
    icon: "folder",
    subNav: documentsSubNav,
  },
  { name: "Updates", href: "/updates", icon: "mailSend" },
  { name: "Reports", href: "/reports", icon: "folderChart" },
  { name: "Audits", href: "/audits", icon: "list" },
];

const llcSections: NavSection[] = [
  {
    items: [
      { name: "Overview", href: "/", icon: "home" },
      { name: "Member schedule", href: "/captable", icon: "pieChart" },
      { name: "Members", href: "/stakeholders", icon: "group" },
      { name: "Unit classes", href: "/unit-classes", icon: "folderChart2" },
    ],
  },
  {
    title: "Capital",
    items: [
      { name: "Admissions", href: "/admissions", icon: "fileText" },
      { name: "Commitments", href: "/commitments", icon: "safe" },
      { name: "Capital calls", href: "/capital-calls", icon: "money" },
    ],
  },
  {
    title: "Operations",
    items: [
      { name: "Distributions", href: "/distributions", icon: "money" },
      {
        name: "Financials",
        href: "/financials",
        icon: "folderChart",
        subNav: [
          { name: "Revenue", href: "/revenue" },
          { name: "Manager payments", href: "/manager-payments" },
          { name: "Reserves", href: "/reserves" },
          { name: "Loans and advances", href: "/loans-advances" },
        ],
      },
      { name: "Fair value", href: "/fair-value", icon: "pieChart" },
    ],
  },
  {
    title: "Governance",
    items: [
      { name: "Resolutions", href: "/resolutions", icon: "fileText" },
      { name: "Transfers", href: "/transfers", icon: "group" },
      { name: "Compliance", href: "/compliance", icon: "list" },
      { name: "Reports", href: "/reports", icon: "folderChart" },
    ],
  },
  {
    title: "Communication",
    items: [
      {
        name: "Documents",
        href: "/documents",
        icon: "folder",
        subNav: [
          ...documentsSubNav,
          { name: "Books and records", href: "/books" },
        ],
      },
      { name: "Updates", href: "/updates", icon: "mailSend" },
      { name: "Email log", href: "/emails", icon: "mailSend" },
      { name: "Audits", href: "/audits", icon: "list" },
    ],
  },
];

const teamNav: CompanyNavItem = {
  id: 1,
  name: "Team",
  rootPath: "/settings/team",
  href: "/settings/team",
  icon: "group",
};

const settingsNav: CompanyNavItem = {
  id: 2,
  name: "Settings",
  rootPath: "/settings/company",
  href: "/settings/company",
  icon: "equalizer",
};

const corporationCompanyNav: CompanyNavItem[] = [
  teamNav,
  settingsNav,
  { id: 3, name: "Form 3921", href: "/3921", icon: "fileText" },
  { id: 4, name: "409A Valuation", href: "/409a", icon: "fileText" },
];

export function getNavSections(entityType: EntityType): NavSection[] {
  return entityType === "LLC"
    ? llcSections
    : [{ items: corporationNavigation }];
}

export function getCompanyNav(entityType: EntityType): CompanyNavItem[] {
  return entityType === "LLC" ? [teamNav, settingsNav] : corporationCompanyNav;
}
