import "server-only";

// Guarded single-row writes (03-governance.md C3, "write-once").
//
// DO NOT use `updateMany` / `deleteMany` with a guard in their `where` (for
// example `{ id, submittedAt: null }`) and treat `count === 1` as "I won".
// Prisma 7 runs those as two statements: it first SELECTs the matching ids,
// then UPDATEs/DELETEs `WHERE id IN (…)` WITHOUT the guard. A concurrent
// writer that changes the guarded column between the two statements is
// silently overwritten and both callers see `count === 1`. For a parent with
// emulated cascades (relationMode = "prisma") `deleteMany` is worse: the
// children are deleted by the stale ids before the guarded parent DELETE.
//
// A single-row `update` / `delete` whose `where` carries the guard is ONE
// statement (`UPDATE … WHERE "id" = $1 AND <guard> RETURNING …`). Postgres
// re-evaluates that WHERE on the newest row version after waiting for a
// concurrent writer's lock (READ COMMITTED), so exactly one writer matches;
// Prisma reports the other as P2025 ("record not found"). The UPDATE itself
// succeeds with zero rows, so the surrounding transaction stays usable.
// `src/server/governance/__integration__/guarded.integration.ts` races two
// writers through this helper and proves both properties.

/** Prisma's "an operation failed because it depends on one or more records that were required but not found". */
export function isRecordNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2025";
}

/**
 * Runs ONE single-row Prisma `update` or `delete` whose `where` names the row
 * by its unique id AND carries the guard, e.g.
 *
 *   await guardedWrite(() =>
 *     tx.resolutionBallot.update({
 *       where: { id, submittedAt: null },
 *       data: { submittedAt: now },
 *       select: { id: true },
 *     }),
 *   );
 *
 * Returns true when the row matched the guard and was written, false when it
 * did not (missing row or guard no longer true). Any other error is rethrown.
 */
export async function guardedWrite(
  write: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (isRecordNotFound(error)) return false;
    throw error;
  }
}
