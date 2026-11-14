-- Manager removal is not handled in this app: drop the resolution type.
-- Refuses to run if any resolution of that type exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Resolution" WHERE "type"::text = 'MANAGER_REMOVAL') THEN
    RAISE EXCEPTION 'A MANAGER_REMOVAL resolution exists; delete or retype it before dropping the type.';
  END IF;
END $$;

ALTER TYPE "ResolutionTypeEnum" RENAME TO "ResolutionTypeEnum_old";
CREATE TYPE "ResolutionTypeEnum" AS ENUM ('GENERAL_CONSENT', 'RELATED_PARTY', 'PURCHASE_ORDER', 'TERM_EXTENSION', 'SUCCESSOR_MANAGER', 'AMENDMENT', 'AUDIT_CALL', 'MEMBER_LOAN');
ALTER TABLE "Resolution" ALTER COLUMN "type" TYPE "ResolutionTypeEnum" USING ("type"::text::"ResolutionTypeEnum");
DROP TYPE "ResolutionTypeEnum_old";
