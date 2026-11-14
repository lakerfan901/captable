// Liveness/readiness check for `/api/health` (src/app/api/health/route.ts).
// Pure: the caller passes the database probe, so the logic is unit-tested
// without Postgres. The body never carries an error message, version, host
// or anything else from the environment.

export const HEALTH_TIMEOUT_MS = 3_000;

export interface HealthResult {
  status: 200 | 503;
  body: { status: "ok" | "unavailable" };
}

/**
 * Runs `probe` (a trivial database query) and resolves 200 when it succeeds
 * within `timeoutMs`, 503 when it throws, rejects or takes longer (an
 * unreachable database host must not hang the check). Never rejects.
 */
export async function checkHealth(
  probe: () => Promise<unknown>,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(probe)
        .then(() => "ok" as const),
      timeout,
    ]);
    if (outcome === "ok") return { status: 200, body: { status: "ok" } };
  } catch {
    // Falls through to 503: the error is logged by the caller, never returned.
  } finally {
    clearTimeout(timer);
  }
  return { status: 503, body: { status: "unavailable" } };
}
