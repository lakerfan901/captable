/**
 * Tenant-ownership checks for client-supplied identifiers.
 *
 * Any procedure or REST route that links a row to the caller's company by an
 * id the client sent (bucket, stakeholder, share class, equity plan,
 * document, member, ...) must first prove that id belongs to the company,
 * otherwise a member of company A can attach (and then read) company B's
 * records. Use `assertCompanyOwns` for that.
 *
 * Buckets carry no company column: ownership is derived from the object key
 * namespace (see `isKeyInCompanyNamespace`) and from existing links, so a
 * bucket is owned by a company when its key is in that company's namespace
 * and it is not already linked to another company's document or template.
 *
 * Kept free of `server-only` and runtime `@/` imports so the rules can be
 * unit tested with in-memory loaders instead of a database.
 */

import { TRPCError } from "@trpc/server";
import { isKeyInCompanyNamespace } from "../lib/upload-authorization";
import type { TPrismaOrTransaction } from "./db";

export type CompanyRef = { id: string; publicId: string };

export type BucketOwnershipRow = {
  id: string;
  key: string;
  documents: { companyId: string }[];
  templates: { companyId: string }[];
};

/** Entities that carry a `companyId` column. */
export type CompanyScopedEntity =
  | "stakeholder"
  | "shareClass"
  | "equityPlan"
  | "document"
  | "member";

export type OwnershipEntity = "bucket" | CompanyScopedEntity;

/**
 * Data access needed by the ownership rules. `prismaOwnershipLoaders` is the
 * real implementation; unit tests pass a small in-memory fake.
 */
export interface TenantOwnershipLoaders {
  getCompany(companyId: string): Promise<CompanyRef | null>;
  getBuckets(bucketIds: string[]): Promise<BucketOwnershipRow[]>;
  /** Returns the subset of `ids` whose row has `companyId`. */
  getOwnedIds(
    entity: CompanyScopedEntity,
    companyId: string,
    ids: string[],
  ): Promise<string[]>;
}

export type CompanyOwnedRefs = {
  bucketIds?: readonly (string | null | undefined)[];
  stakeholderIds?: readonly (string | null | undefined)[];
  shareClassIds?: readonly (string | null | undefined)[];
  equityPlanIds?: readonly (string | null | undefined)[];
  documentIds?: readonly (string | null | undefined)[];
  memberIds?: readonly (string | null | undefined)[];
};

/**
 * Pure rule: a bucket belongs to `company` when its key is in the company's
 * key namespace and every existing link to it is from that same company.
 */
export function isBucketOwnedByCompany(
  bucket: BucketOwnershipRow,
  company: CompanyRef,
): boolean {
  if (!isKeyInCompanyNamespace(bucket.key, company)) {
    return false;
  }

  return (
    bucket.documents.every((doc) => doc.companyId === company.id) &&
    bucket.templates.every((tpl) => tpl.companyId === company.id)
  );
}

function uniqueIds(
  ids: readonly (string | null | undefined)[] | undefined,
): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => !!id))];
}

function missing(requested: string[], found: { id: string }[]): string[] {
  const foundIds = new Set(found.map((row) => row.id));
  return requested.filter((id) => !foundIds.has(id));
}

/**
 * Returns the first entity kind for which at least one requested id is not
 * owned by the company, or null when everything is owned.
 */
export async function findForeignReference(
  loaders: TenantOwnershipLoaders,
  companyId: string,
  refs: CompanyOwnedRefs,
): Promise<OwnershipEntity | null> {
  const bucketIds = uniqueIds(refs.bucketIds);
  if (bucketIds.length) {
    const company = companyId ? await loaders.getCompany(companyId) : null;
    if (!company) {
      return "bucket";
    }
    const owned = (await loaders.getBuckets(bucketIds)).filter((bucket) =>
      isBucketOwnedByCompany(bucket, company),
    );
    if (missing(bucketIds, owned).length) {
      return "bucket";
    }
  }

  const scoped: [
    CompanyScopedEntity,
    (readonly (string | null | undefined)[])?,
  ][] = [
    ["stakeholder", refs.stakeholderIds],
    ["shareClass", refs.shareClassIds],
    ["equityPlan", refs.equityPlanIds],
    ["document", refs.documentIds],
    ["member", refs.memberIds],
  ];

  for (const [entity, requested] of scoped) {
    const ids = uniqueIds(requested);
    if (!ids.length) continue;
    if (!companyId) return entity;
    const ownedIds = await loaders.getOwnedIds(entity, companyId, ids);
    if (
      missing(
        ids,
        ownedIds.map((id) => ({ id })),
      ).length
    ) {
      return entity;
    }
  }

  return null;
}

export function prismaOwnershipLoaders(
  db: TPrismaOrTransaction,
): TenantOwnershipLoaders {
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

  return {
    getCompany: (companyId) =>
      db.company.findUnique({
        where: { id: companyId },
        select: { id: true, publicId: true },
      }),
    getBuckets: (bucketIds) =>
      db.bucket.findMany({
        where: { id: { in: bucketIds } },
        select: {
          id: true,
          key: true,
          documents: { select: { companyId: true } },
          templates: { select: { companyId: true } },
        },
      }),
    getOwnedIds: async (entity, companyId, requested) => {
      const args = {
        where: { id: { in: requested }, companyId },
        select: { id: true },
      } as const;
      switch (entity) {
        case "stakeholder":
          return ids(await db.stakeholder.findMany(args));
        case "shareClass":
          return ids(await db.shareClass.findMany(args));
        case "equityPlan":
          return ids(await db.equityPlan.findMany(args));
        case "document":
          return ids(await db.document.findMany(args));
        case "member":
          return ids(await db.member.findMany(args));
      }
    },
  };
}

/**
 * Throws unless every referenced id belongs to `companyId`. By default throws
 * a tRPC FORBIDDEN error; REST routes pass `onForeign` to throw their own.
 */
export async function assertCompanyOwns(
  db: TPrismaOrTransaction | TenantOwnershipLoaders,
  companyId: string,
  refs: CompanyOwnedRefs,
  onForeign: (entity: OwnershipEntity) => never = (entity) => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `The referenced ${entity} does not belong to this company.`,
    });
  },
): Promise<void> {
  const loaders = "getOwnedIds" in db ? db : prismaOwnershipLoaders(db);
  const foreign = await findForeignReference(loaders, companyId, refs);
  if (foreign) {
    onForeign(foreign);
  }
}

/**
 * Read-side guard: before presigning a private object for a record that was
 * loaded scoped to `company`, confirm the object key is in that company's
 * namespace too (defends against rows linked before link-time checks).
 */
export function assertKeyReadableByCompany(
  key: string,
  company: CompanyRef,
): void {
  if (!isKeyInCompanyNamespace(key, company)) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}
