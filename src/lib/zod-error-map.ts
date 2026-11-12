import { z } from "zod";

/**
 * Zod 4 changed every default issue message ("Required" became
 * "Invalid input: expected string, received undefined", and so on). These
 * messages are shown to users by forms and returned by the tRPC and REST APIs,
 * so this error map restores the Zod 3 wording.
 *
 * Schema-level messages (`.min(1, "Name is required")`, `{ error }` params)
 * still take precedence; this only replaces Zod's built-in defaults.
 *
 * The config lives on `globalThis`, so importing this module once per runtime
 * is enough. It is imported by the tRPC server, the REST API and the client
 * tRPC provider (rendered by the root layout).
 */

type RawIssue = z.core.$ZodRawIssue;

const v3ParsedType = (data: unknown): string => {
  const t = typeof data;
  switch (t) {
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "object": {
      if (data === null) return "null";
      if (Array.isArray(data)) return "array";
      if (
        typeof (data as { then?: unknown }).then === "function" &&
        typeof (data as { catch?: unknown }).catch === "function"
      ) {
        return "promise";
      }
      if (data instanceof Map) return "map";
      if (data instanceof Set) return "set";
      if (data instanceof Date) return "date";
      return "object";
    }
    default:
      return t;
  }
};

const joinValues = (values: readonly unknown[], separator = " | ") =>
  values
    .map((val) => (typeof val === "string" ? `'${val}'` : String(val)))
    .join(separator);

const jsonStringify = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );

const schemaType = (issue: RawIssue): string | undefined => {
  const def: object | undefined = issue.inst?._zod.def;
  return def && "type" in def && typeof def.type === "string"
    ? def.type
    : undefined;
};

/** v3 reported the expected type of records as "object" and tuples as "array". */
const v3ExpectedType = (expected: string) => {
  switch (expected) {
    case "record":
      return "object";
    case "tuple":
      return "array";
    default:
      return expected;
  }
};

const tooSmall = (issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooSmall>) => {
  const { origin, minimum, exact, inclusive } = issue;
  switch (origin) {
    case "array":
    case "set":
      return `Array must contain ${
        exact ? "exactly" : inclusive ? "at least" : "more than"
      } ${minimum} element(s)`;
    case "string":
      return `String must contain ${
        exact ? "exactly" : inclusive ? "at least" : "over"
      } ${minimum} character(s)`;
    case "number":
    case "int":
    case "bigint":
      return `Number must be ${
        exact
          ? "exactly equal to "
          : inclusive
            ? "greater than or equal to "
            : "greater than "
      }${minimum}`;
    case "date":
      return `Date must be ${
        exact
          ? "exactly equal to "
          : inclusive
            ? "greater than or equal to "
            : "greater than "
      }${new Date(Number(minimum))}`;
    default:
      return "Invalid input";
  }
};

const tooBig = (issue: z.core.$ZodRawIssue<z.core.$ZodIssueTooBig>) => {
  const { origin, maximum, exact, inclusive } = issue;
  switch (origin) {
    case "array":
    case "set":
      return `Array must contain ${
        exact ? "exactly" : inclusive ? "at most" : "less than"
      } ${maximum} element(s)`;
    case "string":
      return `String must contain ${
        exact ? "exactly" : inclusive ? "at most" : "under"
      } ${maximum} character(s)`;
    case "number":
    case "int":
      return `Number must be ${
        exact ? "exactly" : inclusive ? "less than or equal to" : "less than"
      } ${maximum}`;
    case "bigint":
      return `BigInt must be ${
        exact ? "exactly" : inclusive ? "less than or equal to" : "less than"
      } ${maximum}`;
    case "date":
      return `Date must be ${
        exact
          ? "exactly"
          : inclusive
            ? "smaller than or equal to"
            : "smaller than"
      } ${new Date(Number(maximum))}`;
    default:
      return "Invalid input";
  }
};

const invalidFormat = (
  issue: z.core.$ZodRawIssue<z.core.$ZodStringFormatIssues>,
) => {
  switch (issue.format) {
    case "includes":
      return `Invalid input: must include "${issue.includes}"`;
    case "starts_with":
      return `Invalid input: must start with "${issue.prefix}"`;
    case "ends_with":
      return `Invalid input: must end with "${issue.suffix}"`;
    case "regex":
      return "Invalid";
    case "ipv4":
    case "ipv6":
      return "Invalid ip";
    default:
      return `Invalid ${issue.format}`;
  }
};

const invalidValue = (
  issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidValue>,
) => {
  // z.literal(): v3 compared by identity without a type check.
  if (schemaType(issue) === "literal") {
    return `Invalid literal value, expected ${jsonStringify(issue.values[0])}`;
  }

  // z.enum() / z.nativeEnum(): v3 type-checked before checking membership.
  // v3's z.enum() only accepted strings (z.nativeEnum() also accepted numbers);
  // both are the same schema in v4, so numbers are only accepted as candidates
  // when the enum has numeric values.
  const input = issue.input;
  const acceptsNumbers = issue.values.some((v) => typeof v === "number");
  if (
    typeof input !== "string" &&
    !(typeof input === "number" && acceptsNumbers)
  ) {
    const received = v3ParsedType(input);
    return received === "undefined"
      ? "Required"
      : `Expected ${joinValues(issue.values)}, received ${received}`;
  }

  return `Invalid enum value. Expected ${joinValues(
    issue.values,
  )}, received '${input}'`;
};

export const zodV3ErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type": {
      const received = v3ParsedType(issue.input);
      if (received === "undefined") return "Required";
      if (issue.expected === "date" && issue.input instanceof Date) {
        return "Invalid date";
      }
      if (issue.expected === "int" && received === "number") {
        return "Expected integer, received float";
      }
      return `Expected ${v3ExpectedType(issue.expected)}, received ${received}`;
    }
    case "invalid_value":
      return invalidValue(issue);
    case "too_small":
      return tooSmall(issue);
    case "too_big":
      return tooBig(issue);
    case "invalid_format":
      return invalidFormat(
        issue as z.core.$ZodRawIssue<z.core.$ZodStringFormatIssues>,
      );
    case "not_multiple_of":
      return `Number must be a multiple of ${issue.divisor}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ", ")}`;
    case "invalid_union":
      if (Array.isArray(issue.options) && issue.options.length > 0) {
        return `Invalid discriminator value. Expected ${joinValues(
          issue.options,
        )}`;
      }
      return "Invalid input";
    case "invalid_key":
    case "invalid_element":
      return issue.issues[0]?.message ?? "Invalid input";
    default:
      return "Invalid input";
  }
};

z.config({ customError: zodV3ErrorMap });
