import type { TPrismaOrTransaction } from "@/server/db";
import {
  assertCompanyOwns,
  type CompanyOwnedRefs,
} from "@/server/tenant-ownership";
import { ApiError } from "../error";

/** REST flavour of `assertCompanyOwns`: answers 403 with an API error body. */
export function assertCompanyOwnsForApi(
  db: TPrismaOrTransaction,
  companyId: string,
  refs: CompanyOwnedRefs,
) {
  return assertCompanyOwns(db, companyId, refs, (entity) => {
    throw new ApiError({
      code: "FORBIDDEN",
      message: `The referenced ${entity} does not belong to this company.`,
    });
  });
}
