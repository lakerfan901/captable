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
] as const;
export type TSubjects = (typeof SUBJECTS)[number];
