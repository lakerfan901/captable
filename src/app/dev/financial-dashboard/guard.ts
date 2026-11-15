// The production guard of the development-only dashboard demo (see page.tsx).

/** Name of the variable that enables the demo in a production build; joined at runtime so it is never inlined. */
export const DEMO_FLAG = ["FINANCIAL", "DASHBOARD", "DEMO"].join("_");

/** True when the demo may be served: any non-production build, or the explicit flag "1". */
export function demoAllowed(
  nodeEnv: string | undefined,
  flag: string | undefined,
): boolean {
  return nodeEnv !== "production" || flag === "1";
}
