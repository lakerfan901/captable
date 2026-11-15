import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The account page shows the reset link only for the server's "current
// password refused" answer, which it recognises by its text. The text is
// written in two files (the procedure is server-only, the form is a client
// component); this test keeps them equal. Source-reading, because vitest has
// no `@/` alias to import either file.

const ROOT = join(__dirname, "..", "..");

function quoted(file: string, name: string): string {
  const source = readFileSync(join(ROOT, file), "utf8");
  const match = new RegExp(`${name}\\s*=\\s*\\n?\\s*"([^"]+)"`).exec(source);
  if (!match?.[1]) throw new Error(`${name} not found in ${file}`);
  return match[1];
}

describe("change password messages", () => {
  it("the form's refusal text equals the procedure's", () => {
    expect(
      quoted("components/portal/password-form.tsx", "CURRENT_PASSWORD_REFUSED"),
    ).toBe(
      quoted(
        "trpc/routers/portal-router/procedures/change-password.ts",
        "CHANGE_PASSWORD_REFUSED_MESSAGE",
      ),
    );
  });

  it("no portal page or component reads the team session", () => {
    const files = [
      "components/portal/password-form.tsx",
      "components/portal/portal-shell.tsx",
      "components/portal/holder-switcher.tsx",
      "components/portal/holder-header.tsx",
      "components/portal/portal-nav.tsx",
      "components/portal/portal-me.ts",
      "app/(portal)/portal/layout.tsx",
      "app/(portal)/portal/(signed-in)/page.tsx",
      "app/(portal)/portal/(signed-in)/not-found.tsx",
      "app/(portal)/portal/(signed-in)/account/page.tsx",
      "app/(portal)/portal/(signed-in)/[access]/layout.tsx",
      "app/(portal)/portal/(signed-in)/[access]/page.tsx",
      "app/(portal)/portal/(signed-in)/[access]/[...missing]/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      expect(source, file).not.toMatch(/\buseSession\s*\(/);
      for (const spec of imports) {
        expect(spec, file).not.toMatch(
          /providers\/next-auth|\(authenticated\)|^@\/server\/auth$/,
        );
        // G5: only the portal routers import the procedure base.
        expect(spec, file).not.toMatch(/portal-procedure/);
      }
    }
  });
});
