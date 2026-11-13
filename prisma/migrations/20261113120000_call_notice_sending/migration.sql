-- Call Notice send path (E9 fix): a line is reserved as SENDING before its
-- email is sent, and `prepaidMatchedAt` records that Balance money already
-- received (R28) was matched to the line after the email was accepted.
-- Explicit transaction, like 20261112202901_llc_mode (`prisma migrate deploy`
-- does not wrap a migration itself). PostgreSQL 12+ allows ADD VALUE inside a
-- transaction block; the new value is not used before COMMIT.
BEGIN;

-- AlterEnum
ALTER TYPE "CallNoticeLineStatusEnum" ADD VALUE IF NOT EXISTS 'SENDING';

-- AlterTable
ALTER TABLE "CallNoticeLine" ADD COLUMN "prepaidMatchedAt" TIMESTAMP(3);

-- Backfill: lines already sent were matched when they were recorded; mark
-- them so `reconcileCallNoticeLines` does not match them a second time.
UPDATE "CallNoticeLine"
SET "prepaidMatchedAt" = COALESCE("sentAt", CURRENT_TIMESTAMP)
WHERE "status" IN ('SENT', 'PAID');

COMMIT;
