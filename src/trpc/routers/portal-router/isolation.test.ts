// Source-reading isolation test of the investor portal (04-investor-portal.md
// 5.3 G1, G2, G5, G6; section 7 S1, S2, S22, S26; package P11).
//
// vitest has no `@/` alias and cannot import the tRPC root, so the guarantees
// are checked on the source text: which base each procedure is built on,
// what each input schema accepts, and what every portal file imports, both
// directly and through the modules it reaches.
//
// "Portal code" here is: the portal pages (src/app/(portal)), the portal
// components (src/components/portal), the two portal routers, and every
// module the portal procedures reach (the read side of src/server/portal and
// the helpers it uses). The reach is computed by following imports from the
// portal procedure files. It stops at two shared bases that are part of the
// design: `src/trpc/api/trpc.ts` (it resolves the next-auth session for every
// tRPC request; `portalSessionProcedure` overwrites it with null before any
// portal code runs, G1) and, for pages, the RSC/React tRPC clients (they
// import the whole app router by type and call portal procedures only).
// `src/server/portal/financial-snapshot-write.ts` reads the ledger and is the
// write side (called by the team's release and Restate); it must not be
// reachable from a portal procedure.
//
// Portal procedures import `member-report-router/procedures/shared`
// (`readFrozenContent`, the validated frozen report): a pure reader of
// stored JSON, not a team procedure. The reach check below proves it brings
// in no session helper, no RBAC base and nothing from the live ledger.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const SRC = join(ROOT, "src");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(p) && !/\.test\.tsx?$/.test(p))
      out.push(p);
  }
  return out;
}

const text = (p: string) => readFileSync(p, "utf8");

/** Removes comments so a word in a comment never counts as code. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

interface ImportRef {
  spec: string;
  /** The text between `import` and `from` (names imported), "" for side effects. */
  clause: string;
}

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): ImportRef[] {
  const src = code(text(file));
  const out: ImportRef[] = [];
  for (const m of src.matchAll(STATIC_IMPORT))
    out.push({ clause: m[1] ?? "", spec: m[2] ?? "" });
  for (const m of src.matchAll(SIDE_EFFECT_IMPORT))
    out.push({ clause: "", spec: m[1] ?? "" });
  for (const m of src.matchAll(DYNAMIC_IMPORT))
    out.push({ clause: "", spec: m[1] ?? "" });
  return out;
}

/** The repository file an import resolves to, or null for a package. */
function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/prisma/")) base = join(ROOT, "prisma", spec.slice(9));
  else if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Unresolved import ${spec} in ${rel(from)}`);
}

/** Every repository file reachable from `roots`, not entering `stops`. */
function reach(roots: string[], stops: Set<string>): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: [string, string[]][] = roots.map((r) => [r, [rel(r)]]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const [file, chain] = next;
    if (seen.has(file)) continue;
    seen.set(file, chain);
    if (stops.has(rel(file))) continue;
    for (const { spec } of importsOf(file)) {
      const target = resolveSpec(spec, file);
      if (target !== null && !seen.has(target))
        queue.push([target, [...chain, rel(target)]]);
    }
  }
  return seen;
}

const PORTAL_ROUTER = join(SRC, "trpc/routers/portal-router");
const PORTAL_AUTH_ROUTER = join(SRC, "trpc/routers/portal-auth-router");
const PORTAL_PROCEDURE = "src/trpc/api/portal-procedure.ts";
const procedureFiles = walk(join(PORTAL_ROUTER, "procedures"));
const portalPages = walk(join(SRC, "app/(portal)"));
const portalComponents = walk(join(SRC, "components/portal"));

/** Procedures built on the session base only (5.4: no holder chosen yet). */
const SESSION_ONLY = new Set(["me.ts", "change-password.ts", "find-report.ts"]);

/** What portal code may never import (G1, G5, G6, S26). */
const BANNED_SPECS: [RegExp, string][] = [
  [/^@\/server\/llc\/economics(\/|$)/, "the live ledger (S26)"],
  [/^@\/server\/auth$/, "the next-auth session (G1)"],
  [/^next-auth(\/|$)/, "next-auth (G1)"],
  [/^@\/providers\/next-auth/, "the team session provider (G1)"],
  [/\(authenticated\)/, "team pages (G6)"],
  [/^@\/lib\/rbac\/access-control$/, "team RBAC (G6)"],
];
const BANNED_NAMES = [
  "getServerAuthSession",
  "withServerComponentSession",
  "useSession",
  "withAuth",
  "withAccessControl",
  "withLlcAccessControl",
  "serverAccessControl",
  "checkMembership",
];

function bannedImports(file: string): string[] {
  const problems: string[] = [];
  for (const { spec, clause } of importsOf(file)) {
    for (const [re, why] of BANNED_SPECS)
      if (re.test(spec)) problems.push(`${rel(file)} imports ${spec}: ${why}`);
    for (const name of BANNED_NAMES)
      if (new RegExp(`\\b${name}\\b`).test(clause))
        problems.push(`${rel(file)} imports ${name} from ${spec}`);
  }
  return problems;
}

/** Repository files that must never be reached from portal code. */
const UNREACHABLE: [RegExp, string][] = [
  [/^src\/server\/llc\/economics\//, "the live ledger (S26)"],
  [/^src\/server\/auth\.ts$/, "the next-auth session (G1)"],
  [/^src\/providers\/next-auth/, "the team session provider (G1)"],
  [/^src\/lib\/rbac\/access-control\.ts$/, "team RBAC (G6)"],
  [/^src\/app\/\(authenticated\)\//, "team pages (G6)"],
  [
    /^src\/server\/portal\/financial-snapshot-write\.ts$/,
    "the snapshot writer (team side)",
  ],
];

/** Balanced-paren argument of the first `.input(` in `src`, or null. */
function inputArgument(src: string): string | null {
  const at = src.indexOf(".input(");
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + ".input".length; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(at + ".input(".length, i);
    }
  }
  return null;
}

/** Keys and identifiers no portal input may carry (G2). */
const FORBIDDEN_INPUT =
  /\b(companyId|companyPublicId|stakeholderId|holderId|portalUserId|memberId|userId|accessId|recipientId|bucketId)\b/;

/**
 * The text of a portal procedure's input schema: the `.input(...)` argument
 * and, when it names a schema, that schema's declaration (in the file or in
 * the module it is imported from).
 */
function inputSchemaText(file: string): string | null {
  const src = code(text(file));
  const arg = inputArgument(src);
  if (arg === null) return null;
  const parts = [arg];
  for (const name of arg.match(/\bZ[A-Za-z0-9_]*\b/g) ?? []) {
    const local = new RegExp(
      `const\\s+${name}\\s*=([\\s\\S]*?)(?:\\n\\s*\\n|;\\n)`,
    ).exec(src);
    if (local) {
      parts.push(local[1] ?? "");
      continue;
    }
    const from = importsOf(file).find((i) =>
      new RegExp(`\\b${name}\\b`).test(i.clause),
    );
    if (from === undefined) throw new Error(`${name} not found for ${file}`);
    const target = resolveSpec(from.spec, file);
    if (target === null) throw new Error(`${name} comes from a package`);
    const decl = new RegExp(
      `const\\s+${name}\\s*=([\\s\\S]*?)(?:\\n\\s*\\n|;\\n)`,
    ).exec(code(text(target)));
    if (decl === null) throw new Error(`${name} not declared in ${target}`);
    parts.push(decl[1] ?? "");
  }
  return parts.join("\n");
}

describe("portal router: every procedure on the portal bases (G5)", () => {
  const router = text(join(PORTAL_ROUTER, "router.ts"));
  const imported = [
    ...router.matchAll(
      /import\s*\{\s*(\w+)\s*\}\s*from\s*"\.\/procedures\/([\w-]+)"/g,
    ),
  ].map((m) => ({ name: m[1] ?? "", file: `${m[2]}.ts` }));

  it("scans every procedure file and every router key maps to one", () => {
    expect(procedureFiles.length).toBeGreaterThanOrEqual(13);
    const files = procedureFiles.map((f) => f.slice(f.lastIndexOf("/") + 1));
    expect(imported.map((i) => i.file).sort()).toEqual([...files].sort());
    const keys = [...router.matchAll(/^\s*(\w+):\s*(\w+Procedure),?$/gm)];
    expect(keys.length).toBe(imported.length);
    for (const [, , value] of keys)
      expect(imported.map((i) => i.name)).toContain(value);
  });

  for (const file of procedureFiles) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const base = SESSION_ONLY.has(name)
      ? "portalSessionProcedure"
      : "investorProcedure";
    it(`${name} is built on ${base}`, () => {
      const src = code(text(file));
      const exported = [
        ...src.matchAll(/export const (\w+Procedure)\s*=\s*(\w+)/g),
      ];
      expect(exported.length).toBe(1);
      expect(exported[0]?.[2]).toBe(base);
      const fromBase = importsOf(file).find(
        (i) => i.spec === "@/trpc/api/portal-procedure",
      );
      expect(fromBase?.clause).toMatch(new RegExp(`\\b${base}\\b`));
      for (const other of [
        "withoutAuth",
        "publicProcedure",
        ...BANNED_NAMES.filter((n) => n.startsWith("with")),
      ])
        expect(src).not.toMatch(new RegExp(`\\b${other}\\b`));
      if (base === "investorProcedure")
        expect(src).not.toMatch(/\bportalSessionProcedure\b/);
    });
  }

  it("portalAuth.requestReset is the one public procedure, and reads no session", () => {
    const files = walk(join(PORTAL_AUTH_ROUTER, "procedures"));
    expect(files.map((f) => f.slice(f.lastIndexOf("/") + 1))).toEqual([
      "request-reset.ts",
    ]);
    const src = code(text(files[0] ?? ""));
    expect(src).toMatch(/export const requestResetProcedure\s*=\s*withoutAuth/);
    expect(src).not.toMatch(/ctx\.session/);
    expect(bannedImports(files[0] ?? "")).toEqual([]);
  });
});

describe("no portal input names a company, holder or person (G2)", () => {
  let schemas = 0;
  for (const file of [
    ...procedureFiles,
    ...walk(join(PORTAL_AUTH_ROUTER, "procedures")),
  ]) {
    it(rel(file), () => {
      const schema = inputSchemaText(file);
      if (schema === null) return; // no input beyond the base's `access`
      schemas++;
      expect(schema).not.toMatch(FORBIDDEN_INPUT);
    });
  }
  it("the base input is the access public id only", () => {
    const src = code(text(join(ROOT, PORTAL_PROCEDURE)));
    expect(src).toMatch(
      /ZInvestorInput = z\.object\(\{ access: z\.string\(\)\.min\(8\)\.max\(64\) \}\)/,
    );
    expect(src).toMatch(/\.input\(ZInvestorInput\)/);
  });
  it("found the input schemas it checked (not vacuous)", () => {
    expect(schemas).toBeGreaterThanOrEqual(8);
  });
});

describe("portal code never imports session helpers, team bases or the ledger", () => {
  const direct = [
    ...portalPages,
    ...portalComponents,
    ...walk(PORTAL_ROUTER),
    ...walk(PORTAL_AUTH_ROUTER),
    join(ROOT, PORTAL_PROCEDURE),
  ];

  it("direct imports (pages, components, routers, the base)", () => {
    expect(portalPages.length).toBeGreaterThanOrEqual(15);
    expect(portalComponents.length).toBeGreaterThanOrEqual(15);
    expect(direct.flatMap(bannedImports)).toEqual([]);
  });

  it("what the portal procedures reach (read side of src/server/portal)", () => {
    const reached = reach(
      [...procedureFiles, ...walk(join(PORTAL_AUTH_ROUTER, "procedures"))],
      new Set(["src/trpc/api/trpc.ts"]),
    );
    const files = [...reached.keys()].map(rel);
    // not vacuous: the visibility modules and the base are in reach
    for (const must of [
      PORTAL_PROCEDURE,
      "src/server/portal/visibility-reports.ts",
      "src/server/portal/visibility-documents.ts",
      "src/server/portal/financial-view.ts",
      "src/server/portal/session.ts",
    ])
      expect(files).toContain(must);
    const problems: string[] = [];
    for (const [file, chain] of reached) {
      for (const [re, why] of UNREACHABLE)
        if (re.test(rel(file))) problems.push(`${why}: ${chain.join(" -> ")}`);
    }
    expect(problems).toEqual([]);
    // and no reached server/portal module imports a banned name directly
    expect(
      [...reached.keys()]
        .filter((f) => rel(f).startsWith("src/server/portal/"))
        .flatMap(bannedImports),
    ).toEqual([]);
  });

  it("what the portal pages and components reach (up to the tRPC clients)", () => {
    const reached = reach(
      [...portalPages, ...portalComponents],
      new Set([
        "src/trpc/server.ts",
        "src/trpc/react.tsx",
        "src/trpc/shared.ts",
      ]),
    );
    const problems: string[] = [];
    for (const [file, chain] of reached) {
      for (const [re, why] of UNREACHABLE)
        if (re.test(rel(file))) problems.push(`${why}: ${chain.join(" -> ")}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("only the portal routers import the portal base (G5)", () => {
  it("no other file imports portal-procedure.ts", () => {
    const offenders = walk(SRC)
      .filter((f) => {
        const r = rel(f);
        return (
          !r.startsWith("src/trpc/routers/portal-router/") &&
          !r.startsWith("src/trpc/routers/portal-auth-router/") &&
          r !== PORTAL_PROCEDURE
        );
      })
      .filter((f) =>
        importsOf(f).some((i) => {
          const target = resolveSpec(i.spec, f);
          return target !== null && rel(target) === PORTAL_PROCEDURE;
        }),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("team procedures of the portal check an RBAC subject (P29, P39)", () => {
  const routers: [string, RegExp][] = [
    ["portal-admin-router", /policies:\s*\{\s*portal:\s*\{\s*allow:/],
    [
      "financial-dashboard-router",
      /policies:\s*\{\s*"llc-financials":\s*\{\s*allow:/,
    ],
  ];
  for (const [dir, policy] of routers) {
    const base = join(SRC, "trpc/routers", dir);
    const router = text(join(base, "router.ts"));
    const files = [
      ...router.matchAll(/from\s*"\.\/procedures\/([\w-]+)"/g),
    ].map((m) => join(base, "procedures", `${m[1]}.ts`));
    it(`${dir}: every router key comes from a procedure file`, () => {
      expect(files.length).toBeGreaterThanOrEqual(5);
      const keys = [...router.matchAll(/^\s*(\w+):\s*(\w+Procedure),?$/gm)];
      expect(keys.length).toBe(files.length);
    });
    for (const file of files) {
      it(`${dir}/${file.slice(file.lastIndexOf("/") + 1)} is withLlcAccessControl with a policy`, () => {
        const src = code(text(file));
        expect(src).toMatch(
          /export const \w+Procedure\s*=\s*withLlcAccessControl\b/,
        );
        expect(src).toMatch(policy);
        expect(src).not.toMatch(/\b(withoutAuth|withAuth|publicProcedure)\b/);
      });
    }
  }

  it("restate needs llc-financials: update and governance: update", () => {
    const src = code(
      text(
        join(
          SRC,
          "trpc/routers/financial-dashboard-router/procedures/restate.ts",
        ),
      ),
    );
    expect(src).toMatch(/"llc-financials":\s*\{\s*allow:\s*\[\s*"update"\s*\]/);
    expect(src).toMatch(/governance:\s*\{\s*allow:\s*\[\s*"update"\s*\]/);
  });

  it("preview as a holder also needs portal: read", () => {
    const src = code(
      text(
        join(
          SRC,
          "trpc/routers/financial-dashboard-router/procedures/published.ts",
        ),
      ),
    );
    expect(src).toMatch(/addPolicies\(\{\s*portal:\s*\{\s*allow:\s*\["read"\]/);
  });

  it("the report procedures that change portal visibility need governance: update", () => {
    const dir = join(SRC, "trpc/routers/member-report-router/procedures");
    for (const name of [
      "release.ts",
      "publish.ts",
      "unpublish.ts",
      "add-recipients.ts",
      "remove-recipient.ts",
    ]) {
      const src = code(text(join(dir, name)));
      expect(src, name).toMatch(/withLlcAccessControl/);
      expect(src, name).toMatch(/governance:\s*\{\s*allow:\s*\["update"\]/);
    }
  });
});
