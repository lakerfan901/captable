export const SUBJECTS = [
  "billing",
  "members",
  "stakeholder",
  "roles",
  "audits",
  "documents",
  "company",
  "developer",
  "bank-accounts",
  "unit-classes",
  "commitments",
  "emails",
  "governance",
  "capital-calls",
  "distributions",
  "llc-financials",
  "llc-terms",
  // Investor portal administration (04-investor-portal.md P29). ADMIN gets
  // it through ADMIN_PERMISSION; a custom role only when edited.
  "portal",
] as const;
export type TSubjects = (typeof SUBJECTS)[number];
