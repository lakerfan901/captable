import { describe, expect, test } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import "./zod-error-map";

/**
 * Differential test: each case builds the same schema with Zod 3 (still
 * shipped as `zod/v3`) and Zod 4 + our error map, parses the same inputs and
 * expects identical issue paths and messages.
 */

type Issues = { path: string; message: string }[];

const issuesOf = (
  result:
    | { success: true }
    | {
        success: false;
        error: { issues: { path: PropertyKey[]; message: string }[] };
      },
): Issues =>
  result.success
    ? []
    : result.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      }));

enum Native {
  A = "A",
  B = "B",
}

const cases: {
  name: string;
  v3: z3.ZodTypeAny;
  v4: z.ZodType;
  inputs: unknown[];
}[] = [
  {
    name: "required / wrong type",
    v3: z3.object({ name: z3.string(), age: z3.number(), ok: z3.boolean() }),
    v4: z.object({ name: z.string(), age: z.number(), ok: z.boolean() }),
    inputs: [{}, { name: 1, age: "1", ok: "yes" }, { name: null }, undefined],
  },
  {
    name: "string length",
    v3: z3.object({ a: z3.string().min(1), b: z3.string().min(2).max(4) }),
    v4: z.object({ a: z.string().min(1), b: z.string().min(2).max(4) }),
    inputs: [
      { a: "", b: "x" },
      { a: "x", b: "xxxxx" },
    ],
  },
  {
    name: "custom messages win",
    v3: z3.object({
      a: z3.string().min(1, { message: "Name is required" }),
      b: z3.string().min(8, "Must be at least 8 characters in length"),
    }),
    v4: z.object({
      a: z.string().min(1, { message: "Name is required" }),
      b: z.string().min(8, "Must be at least 8 characters in length"),
    }),
    inputs: [{ a: "", b: "short" }],
  },
  {
    name: "string formats",
    v3: z3.object({
      email: z3.string().email(),
      url: z3.string().url(),
      cuid: z3.string().cuid(),
      datetime: z3.string().datetime(),
      regex: z3.string().regex(/^a+$/),
      starts: z3.string().startsWith("x"),
    }),
    v4: z.object({
      email: z.string().email(),
      url: z.string().url(),
      cuid: z.string().cuid(),
      datetime: z.string().datetime(),
      regex: z.string().regex(/^a+$/),
      starts: z.string().startsWith("x"),
    }),
    inputs: [
      {
        email: "nope",
        url: "nope",
        cuid: "nope",
        datetime: "2024-01-01",
        regex: "b",
        starts: "y",
      },
    ],
  },
  {
    name: "coerced numbers",
    v3: z3.object({
      a: z3.coerce.number(),
      b: z3.coerce.number().min(1),
      c: z3.coerce.number().positive(),
      d: z3.coerce.number().max(10),
      e: z3.number().int(),
    }),
    v4: z.object({
      a: z.coerce.number<number>(),
      b: z.coerce.number<number>().min(1),
      c: z.coerce.number<number>().positive(),
      d: z.coerce.number<number>().max(10),
      e: z.number().int(),
    }),
    inputs: [
      { a: "abc", b: "0", c: "0", d: "11", e: 1.5 },
      { a: "", b: "", c: "-1", d: "x", e: "1" },
    ],
  },
  {
    name: "coerced dates",
    v3: z3.object({ a: z3.coerce.date(), b: z3.date() }),
    v4: z.object({ a: z.coerce.date<Date>(), b: z.date() }),
    inputs: [{ a: "not a date", b: "2024-01-01" }, {}],
  },
  {
    name: "enums",
    v3: z3.object({
      e: z3.enum(["COMMON", "PREFERRED"]),
      n: z3.nativeEnum(Native),
    }),
    v4: z.object({
      e: z.enum(["COMMON", "PREFERRED"]),
      n: z.nativeEnum(Native),
    }),
    inputs: [{}, { e: "x", n: "x" }, { e: [], n: null }],
  },
  {
    name: "enum with schema-level error",
    v3: z3.nativeEnum(Native, {
      errorMap: () => ({ message: "Invalid value for stakeholderType" }),
    }),
    v4: z.nativeEnum(Native, { error: "Invalid value for stakeholderType" }),
    inputs: ["x", undefined, 1],
  },
  {
    name: "arrays",
    v3: z3.object({
      a: z3.array(z3.string()).nonempty(),
      b: z3.array(z3.string()).min(2),
    }),
    v4: z.object({
      a: z.array(z.string()).nonempty(),
      b: z.array(z.string()).min(2),
    }),
    inputs: [
      { a: [], b: ["x"] },
      { a: [1], b: 1 },
    ],
  },
  {
    name: "literals and unions",
    v3: z3.object({
      l: z3.literal("public-key"),
      u: z3.union([z3.literal("member"), z3.literal("stakeholder")]),
    }),
    v4: z.object({
      l: z.literal("public-key"),
      u: z.union([z.literal("member"), z.literal("stakeholder")]),
    }),
    inputs: [{ l: "x", u: "x" }, {}],
  },
  {
    name: "discriminated union",
    v3: z3.discriminatedUnion("t", [
      z3.object({ t: z3.literal("a"), x: z3.string() }),
      z3.object({ t: z3.literal("b") }),
    ]),
    v4: z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), x: z.string() }),
      z.object({ t: z.literal("b") }),
    ]),
    inputs: [{ t: "c" }, { t: "a" }],
  },
  {
    name: "refine",
    v3: z3
      .object({ p: z3.string(), c: z3.string() })
      .refine((d) => d.p === d.c, {
        message: "Passwords don't match",
        path: ["c"],
      }),
    v4: z.object({ p: z.string(), c: z.string() }).refine((d) => d.p === d.c, {
      message: "Passwords don't match",
      path: ["c"],
    }),
    inputs: [{ p: "a", c: "b" }],
  },
  {
    name: "strict objects",
    v3: z3.object({ a: z3.string() }).strict(),
    v4: z.object({ a: z.string() }).strict(),
    inputs: [{ a: "x", b: 1, c: 2 }],
  },
];

describe("zod v3-compatible error messages", () => {
  for (const c of cases) {
    test(c.name, () => {
      for (const input of c.inputs) {
        expect(issuesOf(c.v4.safeParse(input))).toEqual(
          issuesOf(c.v3.safeParse(input)),
        );
      }
    });
  }
});

describe("zod 4 semantics we compensate for", () => {
  test("defaults behind .optional() apply in v4, so proRata uses plain .optional()", () => {
    expect(
      z.object({ p: z.boolean().default(false).optional() }).parse({}),
    ).toEqual({ p: false });
    expect(
      z3.object({ p: z3.boolean().default(false).optional() }).parse({}),
    ).toEqual({});
    expect(z.object({ p: z.boolean().optional() }).parse({})).toEqual({});
  });

  test("z.any() keys are required in v4, so update content is .optional()", () => {
    expect(z3.object({ a: z3.any() }).safeParse({}).success).toBe(true);
    expect(z.object({ a: z.any() }).safeParse({}).success).toBe(false);
    expect(z.object({ a: z.any().optional() }).safeParse({}).success).toBe(
      true,
    );
  });

  test("enum-keyed records are exhaustive in v4, so permissions use partialRecord", () => {
    const keys = ["roles", "billing"] as const;
    const partial = { roles: { read: true } };
    expect(
      z3
        .record(
          z3.enum(keys),
          z3.record(z3.enum(["read", "create"]), z3.boolean()),
        )
        .safeParse(partial).success,
    ).toBe(true);
    expect(
      z
        .record(z.enum(keys), z.record(z.enum(["read", "create"]), z.boolean()))
        .safeParse(partial).success,
    ).toBe(false);
    expect(
      z
        .partialRecord(
          z.enum(keys),
          z.partialRecord(z.enum(["read", "create"]), z.boolean()),
        )
        .safeParse(partial).success,
    ).toBe(true);
  });

  test("known difference: v4 also runs length checks on wrong-type input", () => {
    // Only reachable by API clients sending the wrong JSON type; the first
    // issue (the one the REST API reports) is unchanged.
    const v3 = issuesOf(
      z3.object({ b: z3.array(z3.string()).min(2) }).safeParse({ b: "x" }),
    );
    const v4 = issuesOf(
      z.object({ b: z.array(z.string()).min(2) }).safeParse({ b: "x" }),
    );
    expect(v4[0]).toEqual(v3[0]);
    expect(v4).toHaveLength(2);
  });

  test("coerce.date() param messages never fired in v3 (always 'Invalid date')", () => {
    const v3 = z3.object({
      d: z3.coerce.date({
        required_error: "Board approval date is required",
        invalid_type_error: "This is not a valid date",
      }),
    });
    const v4 = z.object({ d: z.coerce.date<Date>() });
    for (const input of [{}, { d: "x" }, { d: "" }]) {
      expect(issuesOf(v4.safeParse(input))).toEqual(
        issuesOf(v3.safeParse(input)),
      );
    }
  });
});
