import { TRPCError } from "@trpc/server";
import { describe, expect, test } from "vitest";
import {
  assertCompanyOwns,
  assertKeyReadableByCompany,
  type BucketOwnershipRow,
  type CompanyRef,
  type CompanyScopedEntity,
  findForeignReference,
  isBucketOwnedByCompany,
  type TenantOwnershipLoaders,
} from "./tenant-ownership";

const companyA: CompanyRef = { id: "cmp_a_internal", publicId: "acme" };
const companyB: CompanyRef = { id: "cmp_b_internal", publicId: "globex" };

const bucket = (
  id: string,
  key: string,
  links: { documents?: string[]; templates?: string[] } = {},
): BucketOwnershipRow => ({
  id,
  key,
  documents: (links.documents ?? []).map((companyId) => ({ companyId })),
  templates: (links.templates ?? []).map((companyId) => ({ companyId })),
});

/** In-memory stand-in for the Prisma-backed loaders. */
function fakeLoaders(data: {
  companies?: CompanyRef[];
  buckets?: BucketOwnershipRow[];
  rows?: Partial<
    Record<CompanyScopedEntity, { id: string; companyId: string }[]>
  >;
}): TenantOwnershipLoaders {
  return {
    getCompany: async (id) =>
      (data.companies ?? []).find((company) => company.id === id) ?? null,
    getBuckets: async (ids) =>
      (data.buckets ?? []).filter((row) => ids.includes(row.id)),
    getOwnedIds: async (entity, companyId, ids) =>
      (data.rows?.[entity] ?? [])
        .filter((row) => ids.includes(row.id) && row.companyId === companyId)
        .map((row) => row.id),
  };
}

const world = fakeLoaders({
  companies: [companyA, companyB],
  buckets: [
    bucket("bkt_a_new", "acme/generic-documents-x.pdf"),
    bucket("bkt_a_linked", "acme/new-safes-y.pdf", {
      documents: ["cmp_a_internal"],
    }),
    bucket("bkt_a_signed", "cmp_a_internal/signed-esign-doc.pdf"),
    bucket("bkt_b", "globex/generic-documents-z.pdf", {
      documents: ["cmp_b_internal"],
    }),
    bucket("bkt_tpl_b", "templates/new-safes-abc.pdf", {
      templates: ["cmp_b_internal"],
    }),
    bucket("bkt_tpl_free", "templates/new-safes-def.pdf"),
    // A key in A's namespace that B already linked (e.g. before this fix).
    bucket("bkt_a_poisoned", "acme/generic-documents-p.pdf", {
      documents: ["cmp_a_internal", "cmp_b_internal"],
    }),
  ],
  rows: {
    stakeholder: [
      { id: "sh_a", companyId: "cmp_a_internal" },
      { id: "sh_b", companyId: "cmp_b_internal" },
    ],
    shareClass: [{ id: "sc_a", companyId: "cmp_a_internal" }],
    equityPlan: [{ id: "ep_b", companyId: "cmp_b_internal" }],
    document: [{ id: "doc_b", companyId: "cmp_b_internal" }],
    member: [{ id: "mem_a", companyId: "cmp_a_internal" }],
  },
});

describe("isBucketOwnedByCompany", () => {
  test("accepts an unlinked key in the company's publicId namespace", () => {
    expect(
      isBucketOwnedByCompany(bucket("b", "acme/generic-documents-1"), companyA),
    ).toBe(true);
  });

  test("accepts signed e-sign keys under the internal company id", () => {
    expect(
      isBucketOwnedByCompany(bucket("b", "cmp_a_internal/x.pdf"), companyA),
    ).toBe(true);
  });

  test("rejects another company's namespace", () => {
    expect(
      isBucketOwnedByCompany(
        bucket("b", "globex/generic-documents-1"),
        companyA,
      ),
    ).toBe(false);
  });

  test("rejects a shared template copy already linked to another company", () => {
    expect(
      isBucketOwnedByCompany(
        bucket("b", "templates/new-safes-1.pdf", { templates: [companyB.id] }),
        companyA,
      ),
    ).toBe(false);
  });

  test("rejects a bucket linked to any other company", () => {
    expect(
      isBucketOwnedByCompany(
        bucket("b", "acme/generic-documents-1", {
          documents: [companyA.id, companyB.id],
        }),
        companyA,
      ),
    ).toBe(false);
  });

  test("rejects traversal and absolute keys", () => {
    expect(
      isBucketOwnedByCompany(bucket("b", "acme/../globex/x"), companyA),
    ).toBe(false);
    expect(isBucketOwnedByCompany(bucket("b", "/acme/x"), companyA)).toBe(
      false,
    );
  });
});

describe("findForeignReference", () => {
  test("returns null when every reference is owned", async () => {
    await expect(
      findForeignReference(world, companyA.id, {
        bucketIds: [
          "bkt_a_new",
          "bkt_a_linked",
          "bkt_a_signed",
          "bkt_tpl_free",
        ],
        stakeholderIds: ["sh_a"],
        shareClassIds: ["sc_a", null, undefined],
        memberIds: ["mem_a"],
      }),
    ).resolves.toBeNull();
  });

  test("ignores empty, null and undefined id lists", async () => {
    await expect(
      findForeignReference(world, companyA.id, {
        bucketIds: [],
        stakeholderIds: [null],
        documentIds: undefined,
      }),
    ).resolves.toBeNull();
  });

  test.each([
    ["another company's bucket", { bucketIds: ["bkt_b"] }, "bucket"],
    ["a bucket that does not exist", { bucketIds: ["nope"] }, "bucket"],
    [
      "a template copy linked elsewhere",
      { bucketIds: ["bkt_tpl_b"] },
      "bucket",
    ],
    ["a cross-linked bucket", { bucketIds: ["bkt_a_poisoned"] }, "bucket"],
    [
      "one foreign bucket among owned ones",
      { bucketIds: ["bkt_a_new", "bkt_b"] },
      "bucket",
    ],
    [
      "another company's stakeholder",
      { stakeholderIds: ["sh_b"] },
      "stakeholder",
    ],
    ["an unknown share class", { shareClassIds: ["sc_x"] }, "shareClass"],
    [
      "another company's equity plan",
      { equityPlanIds: ["ep_b"] },
      "equityPlan",
    ],
    ["another company's document", { documentIds: ["doc_b"] }, "document"],
  ] as const)("flags %s", async (_label, refs, entity) => {
    await expect(findForeignReference(world, companyA.id, refs)).resolves.toBe(
      entity,
    );
  });

  test("treats a missing company id as owning nothing", async () => {
    await expect(
      findForeignReference(world, "", { stakeholderIds: ["sh_a"] }),
    ).resolves.toBe("stakeholder");
    await expect(
      findForeignReference(world, "", { bucketIds: ["bkt_a_new"] }),
    ).resolves.toBe("bucket");
  });
});

describe("assertCompanyOwns", () => {
  test("resolves for owned references", async () => {
    await expect(
      assertCompanyOwns(world, companyB.id, {
        bucketIds: ["bkt_b"],
        stakeholderIds: ["sh_b"],
      }),
    ).resolves.toBeUndefined();
  });

  test("throws a tRPC FORBIDDEN error by default", async () => {
    const error = await assertCompanyOwns(world, companyB.id, {
      bucketIds: ["bkt_a_new"],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("FORBIDDEN");
  });

  test("uses a custom error for REST callers", async () => {
    await expect(
      assertCompanyOwns(
        world,
        companyB.id,
        { stakeholderIds: ["sh_a"] },
        (e) => {
          throw new Error(`foreign ${e}`);
        },
      ),
    ).rejects.toThrow("foreign stakeholder");
  });
});

describe("assertKeyReadableByCompany", () => {
  test("allows keys in the company namespace", () => {
    expect(() =>
      assertKeyReadableByCompany("acme/generic-documents-1", companyA),
    ).not.toThrow();
  });

  test("hides keys of other companies as NOT_FOUND", () => {
    const error = (() => {
      try {
        assertKeyReadableByCompany("globex/generic-documents-1", companyA);
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
  });
});
