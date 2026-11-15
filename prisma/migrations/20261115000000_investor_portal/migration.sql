-- Investor portal (docs/llc-mode/04-investor-portal.md, section 4; package P0).
--
-- ADDITIVE ONLY. New enums and new tables (all empty), four nullable columns
-- and one index on "MemberReport", one nullable column on
-- "MemberReportRecipient". Adding a nullable column without a default is a
-- metadata-only change in PostgreSQL (no table rewrite). No backfill and no
-- change to an existing enum: every existing report keeps "publishedAt" null
-- ("never published"), so its emailed links behave exactly as before and
-- nothing becomes visible in the portal to anyone. No snapshot row exists, so
-- no financial figure is visible to any investor until a quarterly or annual
-- report is released under the new flow.
--
-- relationMode = "prisma": no foreign keys are created. References to
-- Stakeholder, Company, Document, Member and MemberReport are plain scalars.
--
-- Roll back: drop the nine new tables, the three new enums, the five new
-- columns and the "MemberReport_companyId_publishedAt_idx" index; no existing
-- data depends on them.

-- Enums -----------------------------------------------------------------------

CREATE TYPE "PortalAccessStatusEnum" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TYPE "PortalTokenPurposeEnum" AS ENUM ('SET_PASSWORD', 'RESET_PASSWORD');

CREATE TYPE "PortalEventEnum" AS ENUM (
  'SIGNED_IN',
  'SIGNED_OUT',
  'ACCOUNT_LOCKED',
  'PASSWORD_SET',
  'REPORT_VIEWED',
  'REPORT_FILE_OPENED',
  'REPORT_EXPORTED',
  'FINANCIALS_EXPORTED',
  'DOCUMENT_OPENED'
);

-- Existing tables: nullable columns only ----------------------------------------

ALTER TABLE "MemberReport"
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "publishedById" TEXT,
  ADD COLUMN "unpublishedAt" TIMESTAMP(3),
  ADD COLUMN "unpublishedById" TEXT;

-- One report per company per quarter or notice: a small table, so a plain
-- (non-concurrent) index build is a short lock.
CREATE INDEX "MemberReport_companyId_publishedAt_idx" ON "MemberReport"("companyId", "publishedAt");

ALTER TABLE "MemberReportRecipient"
  ADD COLUMN "addedById" TEXT;

-- Portal accounts ---------------------------------------------------------------

CREATE TABLE "PortalUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "passwordSetAt" TIMESTAMP(3),
    "failedSignIns" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lockNoticeSentAt" TIMESTAMP(3),
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalUser_email_key" ON "PortalUser"("email");

CREATE TABLE "PortalAccess" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "status" "PortalAccessStatusEnum" NOT NULL DEFAULT 'ACTIVE',
    "invitedById" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviteSentAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledById" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalAccess_publicId_key" ON "PortalAccess"("publicId");
CREATE INDEX "PortalAccess_portalUserId_idx" ON "PortalAccess"("portalUserId");
CREATE INDEX "PortalAccess_companyId_stakeholderId_idx" ON "PortalAccess"("companyId", "stakeholderId");
CREATE UNIQUE INDEX "PortalAccess_portalUserId_stakeholderId_key" ON "PortalAccess"("portalUserId", "stakeholderId");

CREATE TABLE "PortalAccountToken" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "PortalTokenPurposeEnum" NOT NULL,
    "nextPath" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalAccountToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalAccountToken_tokenHash_key" ON "PortalAccountToken"("tokenHash");
CREATE INDEX "PortalAccountToken_portalUserId_createdAt_idx" ON "PortalAccountToken"("portalUserId", "createdAt");

CREATE TABLE "PortalSession" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalSession_tokenHash_key" ON "PortalSession"("tokenHash");
CREATE INDEX "PortalSession_portalUserId_idx" ON "PortalSession"("portalUserId");

-- Sharing, access log, notifications --------------------------------------------

CREATE TABLE "PortalDocumentGrant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalDocumentGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortalDocumentGrant_companyId_stakeholderId_idx" ON "PortalDocumentGrant"("companyId", "stakeholderId");
CREATE INDEX "PortalDocumentGrant_documentId_idx" ON "PortalDocumentGrant"("documentId");
CREATE UNIQUE INDEX "PortalDocumentGrant_documentId_stakeholderId_key" ON "PortalDocumentGrant"("documentId", "stakeholderId");

CREATE TABLE "PortalAccessLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "portalUserId" TEXT NOT NULL,
    "portalAccessId" TEXT,
    "stakeholderId" TEXT,
    "event" "PortalEventEnum" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetName" TEXT,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalAccessLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortalAccessLog_companyId_createdAt_idx" ON "PortalAccessLog"("companyId", "createdAt");
CREATE INDEX "PortalAccessLog_companyId_stakeholderId_createdAt_idx" ON "PortalAccessLog"("companyId", "stakeholderId", "createdAt");
CREATE INDEX "PortalAccessLog_targetType_targetId_idx" ON "PortalAccessLog"("targetType", "targetId");
CREATE INDEX "PortalAccessLog_portalUserId_createdAt_idx" ON "PortalAccessLog"("portalUserId", "createdAt");

CREATE TABLE "PortalNotification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "subjectLine" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "emailLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortalNotification_companyId_createdAt_idx" ON "PortalNotification"("companyId", "createdAt");
CREATE UNIQUE INDEX "PortalNotification_portalUserId_kind_batchKey_key" ON "PortalNotification"("portalUserId", "kind", "batchKey");

-- Financial snapshots (section 5.9) ---------------------------------------------

CREATE TABLE "FinancialSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededAt" TIMESTAMP(3),
    "sourceReportId" TEXT,
    "restateReason" TEXT,
    "data" JSONB NOT NULL,
    "dataHash" TEXT NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenById" TEXT NOT NULL,

    CONSTRAINT "FinancialSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancialSnapshot_companyId_supersededAt_month_idx" ON "FinancialSnapshot"("companyId", "supersededAt", "month");
CREATE UNIQUE INDEX "FinancialSnapshot_companyId_month_version_key" ON "FinancialSnapshot"("companyId", "month", "version");

CREATE TABLE "HolderFinancialSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolderFinancialSnapshot_pkey" PRIMARY KEY ("id")
);

-- Prisma truncates generated index names to 63 characters; these two names are
-- the ones `prisma migrate diff` produces for the schema.
CREATE INDEX "HolderFinancialSnapshot_companyId_stakeholderId_supersededA_idx" ON "HolderFinancialSnapshot"("companyId", "stakeholderId", "supersededAt", "month");
CREATE UNIQUE INDEX "HolderFinancialSnapshot_companyId_stakeholderId_month_versi_key" ON "HolderFinancialSnapshot"("companyId", "stakeholderId", "month", "version");
