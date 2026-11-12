-- LLC mode (F0): one schema migration for all three LLC plans.
-- Explicit transaction: `prisma migrate deploy` does NOT wrap a migration in a
-- transaction by itself (verified: a failure part-way left earlier statements
-- applied). With BEGIN/COMMIT any failure leaves schema and data unchanged.
BEGIN;

-- CreateEnum
CREATE TYPE "EntityTypeEnum" AS ENUM ('CORPORATION', 'LLC');

-- CreateEnum
CREATE TYPE "UnitClassKindEnum" AS ENUM ('PREFERRED', 'COMMON');

-- CreateEnum
CREATE TYPE "DayCountEnum" AS ENUM ('ACTUAL_365');

-- CreateEnum
CREATE TYPE "BalanceReturnStartRuleEnum" AS ENUM ('LATER_OF_RECEIPT_AND_DUE', 'RECEIPT_DATE');

-- CreateEnum
CREATE TYPE "HolderTypeEnum" AS ENUM ('INDIVIDUAL', 'JOINT', 'TRUST', 'ENTITY');

-- CreateEnum
CREATE TYPE "AccreditationBasisEnum" AS ENUM ('NET_WORTH', 'INCOME', 'LICENSE', 'ENTITY_ASSETS', 'ENTITY_ALL_OWNERS_ACCREDITED', 'TRUST_ASSETS');

-- CreateEnum
CREATE TYPE "LlcMemberStatusEnum" AS ENUM ('PROSPECT', 'MEMBER', 'FINANCIAL_INTEREST_ONLY');

-- CreateEnum
CREATE TYPE "CommitmentStatusEnum" AS ENUM ('PENDING', 'ACCEPTED', 'REDUCED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CapitalReceiptKindEnum" AS ENUM ('INITIAL', 'BALANCE', 'REPLACEMENT', 'CREDIT', 'FORFEITURE');

-- CreateEnum
CREATE TYPE "EmailLogStatusEnum" AS ENUM ('SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailBounceStateEnum" AS ENUM ('NONE', 'BOUNCED', 'COMPLAINED');

-- CreateEnum
CREATE TYPE "TemplateWorkflowEnum" AS ENUM ('STANDARD', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "LlcPrefCutoffEnum" AS ENUM ('PAYMENT_DATE', 'PERIOD_END');

-- CreateEnum
CREATE TYPE "LlcLotOrderEnum" AS ENUM ('PRO_RATA', 'FIFO', 'LIFO');

-- CreateEnum
CREATE TYPE "LlcOffsetOrderEnum" AS ENUM ('BALANCE_INTEREST_COSTS', 'COSTS_INTEREST_BALANCE');

-- CreateEnum
CREATE TYPE "LlcHolidayCalendarEnum" AS ENUM ('US_FEDERAL', 'NONE');

-- CreateEnum
CREATE TYPE "CallNoticeKindEnum" AS ENUM ('CALL', 'OUTSIDE_DATE');

-- CreateEnum
CREATE TYPE "CallNoticeStatusEnum" AS ENUM ('DRAFT', 'SENT', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CallNoticeLineStatusEnum" AS ENUM ('UNSENT', 'SENT', 'SEND_FAILED', 'PAID');

-- CreateEnum
CREATE TYPE "CallNoticeAllocationSourceEnum" AS ENUM ('PAYMENT', 'PREPAID', 'OFFSET');

-- CreateEnum
CREATE TYPE "MemberDefaultStatusEnum" AS ENUM ('OPEN', 'CURED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MemberDefaultCureMethodEnum" AS ENUM ('PAID_IN_FULL', 'REPLACEMENT_FUNDED');

-- CreateEnum
CREATE TYPE "MemberDefaultPaymentSourceEnum" AS ENUM ('CASH', 'DISTRIBUTION_OFFSET');

-- CreateEnum
CREATE TYPE "MemberDefaultCreditClauseEnum" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "ExpenseCategoryEnum" AS ENUM ('COLOCATION', 'POWER', 'NETWORK', 'INSURANCE', 'REPAIR_AND_REPLACEMENT', 'SOFTWARE_AND_SUPPORT', 'PROFESSIONAL_FEES', 'TAXES_AND_FILING_FEES', 'BANK_FEES', 'ORGANIZATIONAL_OFFERING', 'EQUIPMENT_ACQUISITION', 'DEFAULT_COLLECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "FundingSourceEnum" AS ENUM ('OPERATING_CASH', 'CAPITAL_CONTRIBUTIONS');

-- CreateEnum
CREATE TYPE "ManagerPaymentCategoryEnum" AS ENUM ('MANAGEMENT_FEE', 'EXPENSE_REIMBURSEMENT', 'PURCHASING_AGENT_PASS_THROUGH', 'OTHER');

-- CreateEnum
CREATE TYPE "ReserveKindEnum" AS ENUM ('MINIMUM_OPERATING', 'ANTICIPATED_EXPENSES', 'LIABILITIES', 'EQUIPMENT_REPAIR_AND_REPLACEMENT', 'COLOCATION_DEPOSITS', 'INSURANCE_DEDUCTIBLES', 'TAXES', 'WORKING_CAPITAL', 'WIND_DOWN');

-- CreateEnum
CREATE TYPE "ReserveEntryTypeEnum" AS ENUM ('ESTABLISH', 'RELEASE');

-- CreateEnum
CREATE TYPE "MemberAdvanceKindEnum" AS ENUM ('TAX_WITHHOLDING', 'COMPOSITE_RETURN', 'ENTITY_LEVEL_TAX', 'IMPUTED_UNDERPAYMENT');

-- CreateEnum
CREATE TYPE "MemberAdvanceRecoverySourceEnum" AS ENUM ('DISTRIBUTION_OFFSET', 'CASH_REPAYMENT');

-- CreateEnum
CREATE TYPE "DistributionTypeEnum" AS ENUM ('OPERATING', 'RETURN_OF_UNUSED_CAPITAL', 'SALE_OR_LIQUIDATION');

-- CreateEnum
CREATE TYPE "DistributionStatusEnum" AS ENUM ('DRAFT', 'FINALIZED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ResolutionTypeEnum" AS ENUM ('GENERAL_CONSENT', 'RELATED_PARTY', 'PURCHASE_ORDER', 'TERM_EXTENSION', 'MANAGER_REMOVAL', 'SUCCESSOR_MANAGER', 'AMENDMENT', 'AUDIT_CALL', 'MEMBER_LOAN');

-- CreateEnum
CREATE TYPE "ResolutionStatusEnum" AS ENUM ('DRAFT', 'SENT', 'EFFECTIVE', 'FAILED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VoteBasisEnum" AS ENUM ('PREFERRED_MAJORITY', 'PREFERRED_SUPERMAJORITY', 'DISINTERESTED_MAJORITY', 'DISINTERESTED_67', 'DISINTERESTED_70');

-- CreateEnum
CREATE TYPE "ResolutionRequirementKindEnum" AS ENUM ('UNIT_VOTE', 'MANAGER_APPROVAL', 'COMMON_MEMBER_APPROVAL', 'AFFECTED_MEMBER_CONSENT');

-- CreateEnum
CREATE TYPE "BallotChoiceEnum" AS ENUM ('FOR', 'AGAINST', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "RecordSnapshotPurposeEnum" AS ENUM ('RESOLUTION', 'MEMBER_REPORT');

-- CreateEnum
CREATE TYPE "MemberReportTypeEnum" AS ENUM ('QUARTERLY', 'ANNUAL', 'TAX_K1', 'NOTICE');

-- CreateEnum
CREATE TYPE "MemberReportStatusEnum" AS ENUM ('DRAFT', 'SENT');

-- CreateEnum
CREATE TYPE "MemberReportAttachmentKindEnum" AS ENUM ('GENERAL', 'BALANCE_SHEET', 'INCOME_STATEMENT', 'K1');

-- CreateEnum
CREATE TYPE "ComplianceDeadlineStatusEnum" AS ENUM ('OPEN', 'DONE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "UnitTransferKindEnum" AS ENUM ('VOLUNTARY', 'PERMITTED_TRANSFEREE', 'INVOLUNTARY', 'DEATH_INCAPACITY');

-- CreateEnum
CREATE TYPE "UnitTransferStatusEnum" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UnitTransferRofrOutcomeEnum" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'NOT_EXERCISED', 'EXERCISED_BY_MANAGER', 'EXERCISED_BY_MEMBERS');

-- CreateEnum
CREATE TYPE "UnitTransferConsentEnum" AS ENUM ('NOT_REQUIRED', 'PENDING', 'GRANTED', 'DENIED');

-- CreateEnum
CREATE TYPE "BooksRecordCategoryEnum" AS ENUM ('MEMBER_LIST', 'ARTICLES_AND_AGREEMENT', 'TAX_RETURNS', 'FINANCIAL_STATEMENTS', 'CONSENTS_AND_MINUTES', 'OTHER_STATUTORY');

-- Emails become unique per company and are stored lower-cased.
-- Order (hand-edited, ruled by the plan owner; 01-foundation.md C5.4):
-- DROP the global index first, then lower-case, then create the per-company index.
-- Lower-casing while the global case-sensitive index still exists would fail on
-- case variants in different companies ("A@x.com" in one, "a@x.com" in another),
-- which are legitimate. Case variants inside ONE company make the CREATE UNIQUE
-- INDEX fail; the migration runs in one explicit transaction, so nothing is changed.
DROP INDEX "Stakeholder_email_key";
UPDATE "Stakeholder" SET "email" = lower("email") WHERE "email" <> lower("email");
CREATE UNIQUE INDEX "Stakeholder_companyId_email_key" ON "Stakeholder"("companyId", "email");

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "entityType" "EntityTypeEnum" NOT NULL DEFAULT 'CORPORATION',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Denver';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "recordCategory" "BooksRecordCategoryEnum",
ADD COLUMN     "recordYear" INTEGER,
ADD COLUMN     "stakeholderId" TEXT;

-- AlterTable
ALTER TABLE "EsignRecipient" ADD COLUMN     "role" TEXT,
ADD COLUMN     "signingOrder" INTEGER,
ADD COLUMN     "stakeholderId" TEXT;

-- AlterTable
ALTER TABLE "Stakeholder" ADD COLUMN     "accreditationBasis" "AccreditationBasisEnum",
ADD COLUMN     "admittedOn" DATE,
ADD COLUMN     "holderType" "HolderTypeEnum",
ADD COLUMN     "isInsider" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "memberStatus" "LlcMemberStatusEnum" NOT NULL DEFAULT 'PROSPECT',
ADD COLUMN     "noticeEmail" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "residenceState" TEXT,
ADD COLUMN     "signerName" TEXT,
ADD COLUMN     "signerTitle" TEXT;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "commitmentId" TEXT,
ADD COLUMN     "isMaster" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signedDocumentId" TEXT,
ADD COLUMN     "sourceTemplateId" TEXT,
ADD COLUMN     "stakeholderId" TEXT,
ADD COLUMN     "workflow" "TemplateWorkflowEnum" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "TemplateField" ADD COLUMN     "semanticKey" TEXT;

-- CreateTable
CREATE TABLE "UnitClass" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "UnitClassKindEnum" NOT NULL,
    "pricePerUnitCents" BIGINT,
    "authorizedUnits" DECIMAL(18,6),
    "fractionalUnitsAllowed" BOOLEAN NOT NULL DEFAULT true,
    "votesPerUnit" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "prefReturnBps" INTEGER NOT NULL DEFAULT 0,
    "prefReturnDayCount" "DayCountEnum" NOT NULL DEFAULT 'ACTUAL_365',
    "balanceReturnStartRule" "BalanceReturnStartRuleEnum" NOT NULL DEFAULT 'LATER_OF_RECEIPT_AND_DUE',
    "residualSplitBps" INTEGER NOT NULL DEFAULT 0,
    "minCommitmentCents" BIGINT,
    "minCommitmentFloorCents" BIGINT,
    "offeringCapCents" BIGINT,
    "initialInstallmentBps" INTEGER NOT NULL DEFAULT 4000,
    "finalClosingDate" DATE,
    "balanceOutsideDate" DATE,
    "acceptanceBusinessDays" INTEGER NOT NULL DEFAULT 10,
    "refundBusinessDays" INTEGER NOT NULL DEFAULT 5,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL,
    "status" "CommitmentStatusEnum" NOT NULL DEFAULT 'PENDING',
    "committedCents" BIGINT NOT NULL,
    "acceptedCents" BIGINT NOT NULL DEFAULT 0,
    "signedOn" DATE,
    "investmentSummaryDate" DATE,
    "accreditationBasis" "AccreditationBasisEnum",
    "acceptedOn" DATE,
    "decidedAt" TIMESTAMP(3),
    "decidedByMemberId" TEXT,
    "minimumWaived" BOOLEAN NOT NULL DEFAULT false,
    "minimumWaiverNote" TEXT,
    "isReplacement" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "notes" TEXT,
    "acceptanceDeadline" DATE,
    "refundDueCents" BIGINT NOT NULL DEFAULT 0,
    "refundDueBy" DATE,
    "refundPaidCents" BIGINT NOT NULL DEFAULT 0,
    "refundPaidOn" DATE,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "unitClassId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapitalReceipt" (
    "id" TEXT NOT NULL,
    "kind" "CapitalReceiptKindEnum" NOT NULL,
    "receivedOn" DATE NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "appliedCents" BIGINT NOT NULL DEFAULT 0,
    "unitsIssued" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "appliedOn" DATE,
    "prefReturnStartDate" DATE,
    "reference" TEXT,
    "note" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "recordedByMemberId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByMemberId" TEXT,
    "voidReason" TEXT,
    "companyId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "unitClassId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapitalReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "EmailLogStatusEnum" NOT NULL,
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "smtpResponse" TEXT,
    "errorMessage" TEXT,
    "bodySha256" TEXT,
    "bounceState" "EmailBounceStateEnum" NOT NULL DEFAULT 'NONE',
    "bouncedAt" TIMESTAMP(3),
    "bounceNote" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "companyId" TEXT,
    "stakeholderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlcTerm" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "replacementFunderOutsideDate" DATE NOT NULL,
    "operationsCommencementDate" DATE,
    "ocdNoticeSentOn" DATE,
    "loiExtensionDays" INTEGER NOT NULL DEFAULT 0,
    "loiDocumentId" TEXT,
    "callNoticeBusinessDays" INTEGER NOT NULL DEFAULT 3,
    "forfeitureCureBusinessDays" INTEGER NOT NULL DEFAULT 5,
    "creditDateMaxDays" INTEGER NOT NULL DEFAULT 30,
    "defaultInterestBps" INTEGER NOT NULL DEFAULT 1200,
    "defaultInterestDayBasis" INTEGER NOT NULL DEFAULT 365,
    "forfeitureBps" INTEGER NOT NULL DEFAULT 5000,
    "replacementCreditBps" INTEGER NOT NULL DEFAULT 5000,
    "managementFeeBps" INTEGER NOT NULL DEFAULT 500,
    "minimumOperatingReserveCents" BIGINT NOT NULL DEFAULT 5000000,
    "orgExpenseCapCents" BIGINT NOT NULL DEFAULT 4000000,
    "distributionDeadlineDays" INTEGER NOT NULL DEFAULT 45,
    "targetSaleYears" INTEGER NOT NULL DEFAULT 5,
    "loiExtensionMaxDays" INTEGER NOT NULL DEFAULT 180,
    "extensionRequestMonthsBefore" INTEGER NOT NULL DEFAULT 9,
    "extensionConsentWindowDays" INTEGER NOT NULL DEFAULT 30,
    "dissolutionElectionDays" INTEGER NOT NULL DEFAULT 180,
    "ocdNoticeBusinessDays" INTEGER NOT NULL DEFAULT 10,
    "prefAccrualCutoff" "LlcPrefCutoffEnum" NOT NULL DEFAULT 'PAYMENT_DATE',
    "accrueOnDefaulterCapital" BOOLEAN NOT NULL DEFAULT true,
    "capitalReturnLotOrder" "LlcLotOrderEnum" NOT NULL DEFAULT 'PRO_RATA',
    "forfeitureBaseNetOfReplacementFunding" BOOLEAN NOT NULL DEFAULT false,
    "defaultOffsetOrder" "LlcOffsetOrderEnum" NOT NULL DEFAULT 'BALANCE_INTEREST_COSTS',
    "includeInsiderDistributionsInManagerList" BOOLEAN NOT NULL DEFAULT true,
    "holidayCalendar" "LlcHolidayCalendarEnum" NOT NULL DEFAULT 'US_FEDERAL',
    "saturdayHolidayObservedFriday" BOOLEAN NOT NULL DEFAULT true,
    "extraHolidays" DATE[],
    "booksClosedThrough" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlcTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallNotice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "CallNoticeKindEnum" NOT NULL DEFAULT 'CALL',
    "status" "CallNoticeStatusEnum" NOT NULL DEFAULT 'DRAFT',
    "purpose" TEXT,
    "bankAccountId" TEXT,
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallNoticeLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "callNoticeId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "amountCalledCents" BIGINT NOT NULL,
    "status" "CallNoticeLineStatusEnum" NOT NULL DEFAULT 'UNSENT',
    "sentAt" TIMESTAMP(3),
    "sentOn" DATE,
    "sentToEmail" TEXT,
    "emailLogId" TEXT,
    "dueOn" DATE,
    "paidInFullOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallNoticeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallNoticeAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "callNoticeLineId" TEXT NOT NULL,
    "capitalReceiptId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "prefReturnStartOn" DATE NOT NULL,
    "source" "CallNoticeAllocationSourceEnum" NOT NULL,
    "reversesAllocationId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallNoticeAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDefault" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "callNoticeLineId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "status" "MemberDefaultStatusEnum" NOT NULL DEFAULT 'OPEN',
    "dueOn" DATE NOT NULL,
    "unpaidAtDueCents" BIGINT NOT NULL,
    "forfeitureDate" DATE NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declaredById" TEXT NOT NULL,
    "forfeitedOn" DATE,
    "unpaidAtForfeitureCents" BIGINT,
    "capitalPaidAtForfeitureCents" BIGINT,
    "forfeitedAmountCents" BIGINT,
    "forfeitureReceiptId" TEXT,
    "unreturnedDeductedCents" BIGINT,
    "extinguishedReturnCents" BIGINT,
    "unitsBefore" DECIMAL(18,6),
    "unitsAfter" DECIMAL(18,6),
    "forfeitureConfirmedAt" TIMESTAMP(3),
    "forfeitureConfirmedById" TEXT,
    "creditDate" DATE,
    "fundedAtCreditCents" BIGINT,
    "creditPoolACents" BIGINT,
    "creditRedirectedCents" BIGINT,
    "creditPoolBCents" BIGINT,
    "creditConfirmedAt" TIMESTAMP(3),
    "creditConfirmedById" TEXT,
    "curedOn" DATE,
    "cureMethod" "MemberDefaultCureMethodEnum",
    "curedAt" TIMESTAMP(3),
    "curedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDefaultFunding" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "memberDefaultId" TEXT NOT NULL,
    "funderStakeholderId" TEXT NOT NULL,
    "funderCommitmentId" TEXT NOT NULL,
    "funderIsInsider" BOOLEAN NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "fundedOn" DATE NOT NULL,
    "capitalReceiptId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberDefaultFunding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDefaultPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "memberDefaultId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "source" "MemberDefaultPaymentSourceEnum" NOT NULL,
    "toBalanceCents" BIGINT NOT NULL DEFAULT 0,
    "toInterestCents" BIGINT NOT NULL DEFAULT 0,
    "toCostsCents" BIGINT NOT NULL DEFAULT 0,
    "capitalReceiptId" TEXT,
    "distributionLineId" TEXT,
    "reversesPaymentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberDefaultPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDefaultCharge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "memberDefaultId" TEXT NOT NULL,
    "incurredOn" DATE NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "documentId" TEXT,
    "reversesChargeId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberDefaultCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDefaultCredit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "memberDefaultId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "clause" "MemberDefaultCreditClauseEnum" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "units" DECIMAL(18,6) NOT NULL,
    "capitalReceiptId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberDefaultCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenuePeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "customerReceiptsCents" BIGINT NOT NULL DEFAULT 0,
    "passThroughFeesCents" BIGINT NOT NULL DEFAULT 0,
    "otherIncomeCents" BIGINT NOT NULL DEFAULT 0,
    "assetSaleProceedsCents" BIGINT NOT NULL DEFAULT 0,
    "insuranceProceedsCents" BIGINT NOT NULL DEFAULT 0,
    "utilizationBps" INTEGER,
    "managementFeeBps" INTEGER NOT NULL,
    "managementFeeCents" BIGINT NOT NULL,
    "notes" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenuePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "incurredOn" DATE NOT NULL,
    "category" "ExpenseCategoryEnum" NOT NULL,
    "payee" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "fundingSource" "FundingSourceEnum" NOT NULL DEFAULT 'OPERATING_CASH',
    "countsTowardOrgCap" BOOLEAN NOT NULL DEFAULT false,
    "memo" TEXT,
    "documentId" TEXT,
    "managerPaymentId" TEXT,
    "resolutionId" TEXT,
    "reversesEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "payee" TEXT NOT NULL,
    "payeeStakeholderId" TEXT,
    "amountCents" BIGINT NOT NULL,
    "category" "ManagerPaymentCategoryEnum" NOT NULL,
    "countsTowardOrgCap" BOOLEAN NOT NULL DEFAULT false,
    "memo" TEXT,
    "documentId" TEXT,
    "resolutionId" TEXT,
    "reversesPaymentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "kind" "ReserveKindEnum" NOT NULL,
    "type" "ReserveEntryTypeEnum" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "fundingSource" "FundingSourceEnum" NOT NULL,
    "releaseTo" "FundingSourceEnum",
    "reason" TEXT NOT NULL,
    "reversesEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReserveEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberLoan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lenderStakeholderId" TEXT NOT NULL,
    "principalCents" BIGINT NOT NULL,
    "interestBps" INTEGER NOT NULL,
    "madeOn" DATE NOT NULL,
    "maturityOn" DATE NOT NULL,
    "noteDocumentId" TEXT,
    "resolutionId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberLoanPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "memberLoanId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "principalCents" BIGINT NOT NULL DEFAULT 0,
    "interestCents" BIGINT NOT NULL DEFAULT 0,
    "fundingSource" "FundingSourceEnum" NOT NULL DEFAULT 'OPERATING_CASH',
    "distributionId" TEXT,
    "reversesPaymentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberLoanPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberAdvance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "kind" "MemberAdvanceKindEnum" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "jurisdiction" TEXT,
    "taxYear" INTEGER,
    "memo" TEXT,
    "documentId" TEXT,
    "reversesAdvanceId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberAdvanceRecovery" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "recoveredOn" DATE NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "source" "MemberAdvanceRecoverySourceEnum" NOT NULL,
    "distributionLineId" TEXT,
    "reversesRecoveryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberAdvanceRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Distribution" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER,
    "type" "DistributionTypeEnum" NOT NULL,
    "status" "DistributionStatusEnum" NOT NULL DEFAULT 'DRAFT',
    "isLiquidation" BOOLEAN NOT NULL DEFAULT false,
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "reversesDistributionId" TEXT,
    "periodStart" DATE,
    "periodEnd" DATE NOT NULL,
    "paymentDate" DATE NOT NULL,
    "inputs" JSONB NOT NULL,
    "availableCashCents" BIGINT,
    "amountCents" BIGINT,
    "tierCCents" BIGINT,
    "tierDCents" BIGINT,
    "tierEPreferredCents" BIGINT,
    "tierECommonCents" BIGINT,
    "totalDefaultOffsetCents" BIGINT,
    "totalTaxOffsetCents" BIGINT,
    "totalNetCents" BIGINT,
    "reserveBalanceCents" BIGINT,
    "snapshot" JSONB,
    "solvencyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Distribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "preferredUnits" DECIMAL(18,6) NOT NULL,
    "commonUnits" DECIMAL(18,6) NOT NULL,
    "unpaidReturnBeforeCents" BIGINT NOT NULL,
    "unreturnedBeforeCents" BIGINT NOT NULL,
    "tierCCents" BIGINT NOT NULL DEFAULT 0,
    "tierDCents" BIGINT NOT NULL DEFAULT 0,
    "tierEPreferredCents" BIGINT NOT NULL DEFAULT 0,
    "tierECommonCents" BIGINT NOT NULL DEFAULT 0,
    "grossCents" BIGINT NOT NULL,
    "defaultOffsetBalanceCents" BIGINT NOT NULL DEFAULT 0,
    "defaultOffsetInterestCents" BIGINT NOT NULL DEFAULT 0,
    "defaultOffsetCostsCents" BIGINT NOT NULL DEFAULT 0,
    "taxAdvanceOffsetCents" BIGINT NOT NULL DEFAULT 0,
    "netCents" BIGINT NOT NULL,
    "paidOn" DATE,
    "paymentReference" TEXT,
    "noticeEmailLogId" TEXT,
    "noticeSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "purpose" "RecordSnapshotPurposeEnum" NOT NULL,
    "recordDate" DATE NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenById" TEXT,
    "preferredIssued" DECIMAL(18,6) NOT NULL,
    "preferredOutstanding" DECIMAL(18,6) NOT NULL,
    "disinterestedOutstanding" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "RecordSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordSnapshotEntry" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "memberStatus" TEXT NOT NULL,
    "isMember" BOOLEAN NOT NULL,
    "isInsider" BOOLEAN NOT NULL,
    "isSuspended" BOOLEAN NOT NULL,
    "preferredUnits" DECIMAL(18,6) NOT NULL,
    "commonUnits" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "RecordSnapshotEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resolution" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "ResolutionTypeEnum" NOT NULL,
    "status" "ResolutionStatusEnum" NOT NULL DEFAULT 'DRAFT',
    "referenceCode" TEXT,
    "title" TEXT NOT NULL,
    "matterKey" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "body" JSONB NOT NULL DEFAULT '[]',
    "frozenContent" JSONB,
    "frozenHash" TEXT,
    "recordDate" DATE,
    "snapshotId" TEXT,
    "sentAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "autoReminders" BOOLEAN NOT NULL DEFAULT true,
    "copyDueOn" DATE,
    "copyDeliveredAt" TIMESTAMP(3),
    "resultNotifiedAt" TIMESTAMP(3),
    "executedDocumentId" TEXT,
    "clonedFromId" TEXT,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionRequirement" (
    "id" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ResolutionRequirementKindEnum" NOT NULL,
    "basis" "VoteBasisEnum",
    "stakeholderId" TEXT,
    "section" TEXT NOT NULL,
    "denominatorUnits" DECIMAL(18,6),
    "minimumForUnits" DECIMAL(18,6),
    "satisfiedAt" TIMESTAMP(3),
    "forUnitsAtClose" DECIMAL(18,6),
    "approvedByMemberId" TEXT,
    "approverName" TEXT,
    "approverCapacity" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalIp" TEXT,
    "approvalUserAgent" TEXT,

    CONSTRAINT "ResolutionRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionBallot" (
    "id" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "preferredUnits" DECIMAL(18,6) NOT NULL,
    "countsPreferred" BOOLEAN NOT NULL,
    "countsDisinterested" BOOLEAN NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "tokenRevokedAt" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "inviteEmailLogId" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "firstViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "choice" "BallotChoiceEnum",
    "deemed" BOOLEAN NOT NULL DEFAULT false,
    "signedName" TEXT,
    "signerCapacity" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submitIp" TEXT,
    "submitUserAgent" TEXT,
    "bodyHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResolutionBallot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionEvent" (
    "id" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ballotId" TEXT,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "summary" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberReport" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "MemberReportTypeEnum" NOT NULL,
    "status" "MemberReportStatusEnum" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "fiscalYear" INTEGER,
    "fiscalQuarter" INTEGER,
    "periodStart" DATE,
    "periodEnd" DATE,
    "noticeKind" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "figures" JSONB NOT NULL DEFAULT '{}',
    "commentary" JSONB NOT NULL DEFAULT '[]',
    "frozenContent" JSONB,
    "frozenHash" TEXT,
    "dueOn" DATE,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "authorId" TEXT NOT NULL,
    "filedDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberReportRecipient" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "tokenRevokedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "emailLogId" TEXT,
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "firstViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberReportRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberReportAttachment" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "MemberReportAttachmentKindEnum" NOT NULL DEFAULT 'GENERAL',
    "name" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "stakeholderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberReportAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceDeadline" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "section" TEXT,
    "description" TEXT,
    "dueOn" DATE NOT NULL,
    "status" "ComplianceDeadlineStatusEnum" NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "satisfiedByType" TEXT,
    "satisfiedById" TEXT,
    "note" TEXT,
    "remindedBuckets" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceDeadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitTransfer" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "UnitTransferKindEnum" NOT NULL,
    "status" "UnitTransferStatusEnum" NOT NULL DEFAULT 'OPEN',
    "fromStakeholderId" TEXT NOT NULL,
    "toStakeholderId" TEXT,
    "unitClassId" TEXT NOT NULL,
    "unitClassKind" TEXT NOT NULL,
    "units" DECIMAL(18,6) NOT NULL,
    "noticeReceivedOn" DATE NOT NULL,
    "proposedPriceCents" BIGINT,
    "terms" TEXT,
    "bonaFideOffer" BOOLEAN NOT NULL DEFAULT false,
    "noticeCopyDueOn" DATE,
    "noticeCopyReportId" TEXT,
    "managerRofrEndsOn" DATE,
    "memberRofrEndsOn" DATE,
    "closeByOn" DATE,
    "rofrOutcome" "UnitTransferRofrOutcomeEnum" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "rofrDecidedOn" DATE,
    "rofrNote" TEXT,
    "managerConsent" "UnitTransferConsentEnum" NOT NULL DEFAULT 'NOT_REQUIRED',
    "managerConsentOn" DATE,
    "managerConsentNote" TEXT,
    "securitiesOpinion" TEXT,
    "priceEstablishedOn" DATE,
    "purchaseCloseByOn" DATE,
    "transferNoticeOn" DATE,
    "effectiveOn" DATE,
    "requiredResolutionId" TEXT,
    "exemptUnder71" BOOLEAN NOT NULL DEFAULT false,
    "exemptNote" TEXT,
    "admissionSignaturePage" BOOLEAN NOT NULL DEFAULT false,
    "admissionExpensesPaid" BOOLEAN NOT NULL DEFAULT false,
    "admissionQualified" BOOLEAN NOT NULL DEFAULT false,
    "admissionManagerConsent" BOOLEAN NOT NULL DEFAULT false,
    "admittedOn" DATE,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "notes" TEXT,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitClass_companyId_idx" ON "UnitClass"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitClass_companyId_kind_key" ON "UnitClass"("companyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "UnitClass_companyId_name_key" ON "UnitClass"("companyId", "name");

-- CreateIndex
CREATE INDEX "Commitment_companyId_idx" ON "Commitment"("companyId");

-- CreateIndex
CREATE INDEX "Commitment_companyId_status_idx" ON "Commitment"("companyId", "status");

-- CreateIndex
CREATE INDEX "Commitment_stakeholderId_idx" ON "Commitment"("stakeholderId");

-- CreateIndex
CREATE INDEX "Commitment_unitClassId_idx" ON "Commitment"("unitClassId");

-- CreateIndex
CREATE INDEX "CapitalReceipt_companyId_idx" ON "CapitalReceipt"("companyId");

-- CreateIndex
CREATE INDEX "CapitalReceipt_commitmentId_idx" ON "CapitalReceipt"("commitmentId");

-- CreateIndex
CREATE INDEX "CapitalReceipt_stakeholderId_idx" ON "CapitalReceipt"("stakeholderId");

-- CreateIndex
CREATE INDEX "CapitalReceipt_unitClassId_idx" ON "CapitalReceipt"("unitClassId");

-- CreateIndex
CREATE INDEX "CapitalReceipt_companyId_receivedOn_idx" ON "CapitalReceipt"("companyId", "receivedOn");

-- CreateIndex
CREATE INDEX "CapitalReceipt_sourceType_sourceId_idx" ON "CapitalReceipt"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "EmailLog_companyId_createdAt_idx" ON "EmailLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_stakeholderId_idx" ON "EmailLog"("stakeholderId");

-- CreateIndex
CREATE INDEX "EmailLog_relatedType_relatedId_idx" ON "EmailLog"("relatedType", "relatedId");

-- CreateIndex
CREATE UNIQUE INDEX "LlcTerm_companyId_key" ON "LlcTerm"("companyId");

-- CreateIndex
CREATE INDEX "CallNotice_companyId_idx" ON "CallNotice"("companyId");

-- CreateIndex
CREATE INDEX "CallNotice_bankAccountId_idx" ON "CallNotice"("bankAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CallNotice_companyId_number_key" ON "CallNotice"("companyId", "number");

-- CreateIndex
CREATE INDEX "CallNoticeLine_companyId_idx" ON "CallNoticeLine"("companyId");

-- CreateIndex
CREATE INDEX "CallNoticeLine_callNoticeId_idx" ON "CallNoticeLine"("callNoticeId");

-- CreateIndex
CREATE INDEX "CallNoticeLine_stakeholderId_idx" ON "CallNoticeLine"("stakeholderId");

-- CreateIndex
CREATE INDEX "CallNoticeLine_commitmentId_idx" ON "CallNoticeLine"("commitmentId");

-- CreateIndex
CREATE UNIQUE INDEX "CallNoticeLine_callNoticeId_commitmentId_key" ON "CallNoticeLine"("callNoticeId", "commitmentId");

-- CreateIndex
CREATE UNIQUE INDEX "CallNoticeAllocation_reversesAllocationId_key" ON "CallNoticeAllocation"("reversesAllocationId");

-- CreateIndex
CREATE INDEX "CallNoticeAllocation_companyId_idx" ON "CallNoticeAllocation"("companyId");

-- CreateIndex
CREATE INDEX "CallNoticeAllocation_callNoticeLineId_idx" ON "CallNoticeAllocation"("callNoticeLineId");

-- CreateIndex
CREATE INDEX "CallNoticeAllocation_capitalReceiptId_idx" ON "CallNoticeAllocation"("capitalReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDefault_callNoticeLineId_key" ON "MemberDefault"("callNoticeLineId");

-- CreateIndex
CREATE INDEX "MemberDefault_companyId_idx" ON "MemberDefault"("companyId");

-- CreateIndex
CREATE INDEX "MemberDefault_stakeholderId_idx" ON "MemberDefault"("stakeholderId");

-- CreateIndex
CREATE INDEX "MemberDefault_commitmentId_idx" ON "MemberDefault"("commitmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDefaultFunding_capitalReceiptId_key" ON "MemberDefaultFunding"("capitalReceiptId");

-- CreateIndex
CREATE INDEX "MemberDefaultFunding_companyId_idx" ON "MemberDefaultFunding"("companyId");

-- CreateIndex
CREATE INDEX "MemberDefaultFunding_memberDefaultId_idx" ON "MemberDefaultFunding"("memberDefaultId");

-- CreateIndex
CREATE INDEX "MemberDefaultFunding_funderStakeholderId_idx" ON "MemberDefaultFunding"("funderStakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDefaultPayment_reversesPaymentId_key" ON "MemberDefaultPayment"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "MemberDefaultPayment_companyId_idx" ON "MemberDefaultPayment"("companyId");

-- CreateIndex
CREATE INDEX "MemberDefaultPayment_memberDefaultId_idx" ON "MemberDefaultPayment"("memberDefaultId");

-- CreateIndex
CREATE INDEX "MemberDefaultPayment_distributionLineId_idx" ON "MemberDefaultPayment"("distributionLineId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDefaultCharge_reversesChargeId_key" ON "MemberDefaultCharge"("reversesChargeId");

-- CreateIndex
CREATE INDEX "MemberDefaultCharge_companyId_idx" ON "MemberDefaultCharge"("companyId");

-- CreateIndex
CREATE INDEX "MemberDefaultCharge_memberDefaultId_idx" ON "MemberDefaultCharge"("memberDefaultId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDefaultCredit_capitalReceiptId_key" ON "MemberDefaultCredit"("capitalReceiptId");

-- CreateIndex
CREATE INDEX "MemberDefaultCredit_companyId_idx" ON "MemberDefaultCredit"("companyId");

-- CreateIndex
CREATE INDEX "MemberDefaultCredit_memberDefaultId_idx" ON "MemberDefaultCredit"("memberDefaultId");

-- CreateIndex
CREATE INDEX "MemberDefaultCredit_stakeholderId_idx" ON "MemberDefaultCredit"("stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberDefaultCredit_memberDefaultId_stakeholderId_clause_key" ON "MemberDefaultCredit"("memberDefaultId", "stakeholderId", "clause");

-- CreateIndex
CREATE INDEX "RevenuePeriod_companyId_idx" ON "RevenuePeriod"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "RevenuePeriod_companyId_month_key" ON "RevenuePeriod"("companyId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseEntry_reversesEntryId_key" ON "ExpenseEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "ExpenseEntry_companyId_incurredOn_idx" ON "ExpenseEntry"("companyId", "incurredOn");

-- CreateIndex
CREATE INDEX "ExpenseEntry_managerPaymentId_idx" ON "ExpenseEntry"("managerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerPayment_reversesPaymentId_key" ON "ManagerPayment"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "ManagerPayment_companyId_paidOn_idx" ON "ManagerPayment"("companyId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "ReserveEntry_reversesEntryId_key" ON "ReserveEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "ReserveEntry_companyId_effectiveOn_idx" ON "ReserveEntry"("companyId", "effectiveOn");

-- CreateIndex
CREATE INDEX "MemberLoan_companyId_idx" ON "MemberLoan"("companyId");

-- CreateIndex
CREATE INDEX "MemberLoan_lenderStakeholderId_idx" ON "MemberLoan"("lenderStakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberLoanPayment_reversesPaymentId_key" ON "MemberLoanPayment"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "MemberLoanPayment_companyId_paidOn_idx" ON "MemberLoanPayment"("companyId", "paidOn");

-- CreateIndex
CREATE INDEX "MemberLoanPayment_memberLoanId_idx" ON "MemberLoanPayment"("memberLoanId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberAdvance_reversesAdvanceId_key" ON "MemberAdvance"("reversesAdvanceId");

-- CreateIndex
CREATE INDEX "MemberAdvance_companyId_idx" ON "MemberAdvance"("companyId");

-- CreateIndex
CREATE INDEX "MemberAdvance_stakeholderId_idx" ON "MemberAdvance"("stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberAdvanceRecovery_reversesRecoveryId_key" ON "MemberAdvanceRecovery"("reversesRecoveryId");

-- CreateIndex
CREATE INDEX "MemberAdvanceRecovery_companyId_idx" ON "MemberAdvanceRecovery"("companyId");

-- CreateIndex
CREATE INDEX "MemberAdvanceRecovery_stakeholderId_idx" ON "MemberAdvanceRecovery"("stakeholderId");

-- CreateIndex
CREATE INDEX "MemberAdvanceRecovery_distributionLineId_idx" ON "MemberAdvanceRecovery"("distributionLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Distribution_reversesDistributionId_key" ON "Distribution"("reversesDistributionId");

-- CreateIndex
CREATE INDEX "Distribution_companyId_status_idx" ON "Distribution"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Distribution_companyId_number_key" ON "Distribution"("companyId", "number");

-- CreateIndex
CREATE INDEX "DistributionLine_companyId_idx" ON "DistributionLine"("companyId");

-- CreateIndex
CREATE INDEX "DistributionLine_distributionId_idx" ON "DistributionLine"("distributionId");

-- CreateIndex
CREATE INDEX "DistributionLine_stakeholderId_idx" ON "DistributionLine"("stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "DistributionLine_distributionId_stakeholderId_key" ON "DistributionLine"("distributionId", "stakeholderId");

-- CreateIndex
CREATE INDEX "RecordSnapshot_companyId_idx" ON "RecordSnapshot"("companyId");

-- CreateIndex
CREATE INDEX "RecordSnapshotEntry_snapshotId_idx" ON "RecordSnapshotEntry"("snapshotId");

-- CreateIndex
CREATE INDEX "RecordSnapshotEntry_companyId_stakeholderId_idx" ON "RecordSnapshotEntry"("companyId", "stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordSnapshotEntry_snapshotId_stakeholderId_key" ON "RecordSnapshotEntry"("snapshotId", "stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "Resolution_snapshotId_key" ON "Resolution"("snapshotId");

-- CreateIndex
CREATE INDEX "Resolution_companyId_status_idx" ON "Resolution"("companyId", "status");

-- CreateIndex
CREATE INDEX "Resolution_companyId_type_idx" ON "Resolution"("companyId", "type");

-- CreateIndex
CREATE INDEX "Resolution_authorId_idx" ON "Resolution"("authorId");

-- CreateIndex
CREATE INDEX "Resolution_executedDocumentId_idx" ON "Resolution"("executedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "Resolution_publicId_key" ON "Resolution"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Resolution_companyId_referenceCode_key" ON "Resolution"("companyId", "referenceCode");

-- CreateIndex
CREATE INDEX "ResolutionRequirement_resolutionId_idx" ON "ResolutionRequirement"("resolutionId");

-- CreateIndex
CREATE INDEX "ResolutionRequirement_companyId_idx" ON "ResolutionRequirement"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionRequirement_resolutionId_position_key" ON "ResolutionRequirement"("resolutionId", "position");

-- CreateIndex
CREATE INDEX "ResolutionBallot_resolutionId_idx" ON "ResolutionBallot"("resolutionId");

-- CreateIndex
CREATE INDEX "ResolutionBallot_companyId_stakeholderId_idx" ON "ResolutionBallot"("companyId", "stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionBallot_resolutionId_stakeholderId_key" ON "ResolutionBallot"("resolutionId", "stakeholderId");

-- CreateIndex
CREATE INDEX "ResolutionEvent_resolutionId_idx" ON "ResolutionEvent"("resolutionId");

-- CreateIndex
CREATE INDEX "ResolutionEvent_companyId_idx" ON "ResolutionEvent"("companyId");

-- CreateIndex
CREATE INDEX "ResolutionEvent_ballotId_idx" ON "ResolutionEvent"("ballotId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionEvent_resolutionId_dedupeKey_key" ON "ResolutionEvent"("resolutionId", "dedupeKey");

-- CreateIndex
CREATE INDEX "MemberReport_companyId_type_idx" ON "MemberReport"("companyId", "type");

-- CreateIndex
CREATE INDEX "MemberReport_companyId_status_idx" ON "MemberReport"("companyId", "status");

-- CreateIndex
CREATE INDEX "MemberReport_authorId_idx" ON "MemberReport"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberReport_publicId_key" ON "MemberReport"("publicId");

-- CreateIndex
CREATE INDEX "MemberReportRecipient_reportId_idx" ON "MemberReportRecipient"("reportId");

-- CreateIndex
CREATE INDEX "MemberReportRecipient_companyId_stakeholderId_idx" ON "MemberReportRecipient"("companyId", "stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberReportRecipient_reportId_stakeholderId_key" ON "MemberReportRecipient"("reportId", "stakeholderId");

-- CreateIndex
CREATE INDEX "MemberReportAttachment_reportId_idx" ON "MemberReportAttachment"("reportId");

-- CreateIndex
CREATE INDEX "MemberReportAttachment_bucketId_idx" ON "MemberReportAttachment"("bucketId");

-- CreateIndex
CREATE INDEX "MemberReportAttachment_companyId_stakeholderId_idx" ON "MemberReportAttachment"("companyId", "stakeholderId");

-- CreateIndex
CREATE INDEX "ComplianceDeadline_companyId_status_dueOn_idx" ON "ComplianceDeadline"("companyId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceDeadline_companyId_dedupeKey_key" ON "ComplianceDeadline"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "UnitTransfer_companyId_status_idx" ON "UnitTransfer"("companyId", "status");

-- CreateIndex
CREATE INDEX "UnitTransfer_companyId_fromStakeholderId_idx" ON "UnitTransfer"("companyId", "fromStakeholderId");

-- CreateIndex
CREATE INDEX "UnitTransfer_companyId_toStakeholderId_idx" ON "UnitTransfer"("companyId", "toStakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitTransfer_publicId_key" ON "UnitTransfer"("publicId");

-- CreateIndex
CREATE INDEX "Document_stakeholderId_idx" ON "Document"("stakeholderId");

-- CreateIndex
CREATE INDEX "Document_companyId_recordCategory_idx" ON "Document"("companyId", "recordCategory");

-- CreateIndex
CREATE INDEX "EsignRecipient_stakeholderId_idx" ON "EsignRecipient"("stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "Template_commitmentId_key" ON "Template"("commitmentId");

-- CreateIndex
CREATE INDEX "Template_stakeholderId_idx" ON "Template"("stakeholderId");

-- CreateIndex
CREATE INDEX "Template_companyId_workflow_isMaster_idx" ON "Template"("companyId", "workflow", "isMaster");

COMMIT;
