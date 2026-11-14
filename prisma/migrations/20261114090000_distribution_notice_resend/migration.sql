-- Distribution notice re-send (E17 follow-up): operational columns only, no
-- economic column changes. Adding a column with a constant default is a
-- metadata-only change in PostgreSQL 11+ (no table rewrite).
ALTER TABLE "DistributionLine"
  ADD COLUMN "noticeSendCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "noticeResendingAt" TIMESTAMP(3),
  ADD COLUMN "noticeLastSentAt" TIMESTAMP(3);

-- A line whose first notice was recorded counts one accepted email.
UPDATE "DistributionLine"
SET "noticeSendCount" = 1
WHERE "noticeEmailLogId" IS NOT NULL;
