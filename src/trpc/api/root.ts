import { createTRPCRouter } from "@/trpc/api/trpc";
import { accessTokenRouter } from "../routers/access-token/router";
import { admissionRouter } from "../routers/admission-router/router";
import { auditRouter } from "../routers/audit-router/router";
import { authRouter } from "../routers/auth/router";
import { ballotRouter } from "../routers/ballot-router/router";
import { bankAccountsRouter } from "../routers/bank-accounts/router";
import { billingRouter } from "../routers/billing-router/router";
import { booksRouter } from "../routers/books-router/router";
import { bucketRouter } from "../routers/bucket-router/router";
import { commitmentRouter } from "../routers/commitment-router/router";
import { commonRouter } from "../routers/common/router";
import { companyRouter } from "../routers/company-router/router";
import { complianceRouter } from "../routers/compliance-router/router";
import { dataRoomRouter } from "../routers/data-room-router/router";
import { documentRouter } from "../routers/document-router/router";
import { documentShareRouter } from "../routers/document-share-router/router";
import { emailLogRouter } from "../routers/email-log-router/router";
import { equityPlanRouter } from "../routers/equity-plan/router";
import { governanceRouter } from "../routers/governance-router/router";
import { memberReportRouter } from "../routers/member-report-router/router";
import { memberReportViewRouter } from "../routers/member-report-view-router/router";
import { memberRouter } from "../routers/member-router/router";
import { memberScheduleRouter } from "../routers/member-schedule-router/router";
import { onboardingRouter } from "../routers/onboarding-router/router";
import { passkeyRouter } from "../routers/passkey-router/router";
import { rbacRouter } from "../routers/rbac-router/router";
import { resolutionRouter } from "../routers/resolution-router/router";
import { safeRouter } from "../routers/safe/router";
import { securitiesRouter } from "../routers/securities-router/router";
import { securityRouter } from "../routers/security-router/router";
import { shareClassRouter } from "../routers/share-class/router";
import { stakeholderRouter } from "../routers/stakeholder-router/router";
import { templateFieldRouter } from "../routers/template-field-router/router";
import { templateRouter } from "../routers/template-router/router";
import { unitClassRouter } from "../routers/unit-class-router/router";
import { unitTransferRouter } from "../routers/unit-transfer-router/router";
import { updateRouter } from "../routers/update/router";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  audit: auditRouter,
  company: companyRouter,
  document: documentRouter,
  documentShare: documentShareRouter,
  onboarding: onboardingRouter,
  shareClass: shareClassRouter,
  equityPlan: equityPlanRouter,
  member: memberRouter,
  bucket: bucketRouter,
  template: templateRouter,
  templateField: templateFieldRouter,
  stakeholder: stakeholderRouter,
  securities: securitiesRouter,
  safe: safeRouter,
  update: updateRouter,
  auth: authRouter,
  dataRoom: dataRoomRouter,
  common: commonRouter,
  passkey: passkeyRouter,
  security: securityRouter,
  billing: billingRouter,
  rbac: rbacRouter,
  accessToken: accessTokenRouter,
  bankAccounts: bankAccountsRouter,
  unitClass: unitClassRouter,
  commitment: commitmentRouter,
  memberSchedule: memberScheduleRouter,
  admission: admissionRouter,
  emailLog: emailLogRouter,
  resolution: resolutionRouter,
  ballot: ballotRouter,
  memberReport: memberReportRouter,
  memberReportView: memberReportViewRouter,
  compliance: complianceRouter,
  unitTransfer: unitTransferRouter,
  books: booksRouter,
  governance: governanceRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
