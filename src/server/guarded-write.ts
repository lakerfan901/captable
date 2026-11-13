/**
 * Guarded single-row writes that keep holding when two transactions race.
 *
 * Do NOT use `updateMany({ where: { id, status: "X" } })` with "count must be
 * 1" as a compare-and-set. Prisma 7 runs `updateMany` as two statements: it
 * first SELECTs the matching ids, then runs `UPDATE … WHERE id IN (…)`
 * without the filter. A writer that blocked on the row lock therefore
 * overwrites the row after the first writer commits, even though the filter
 * no longer matches. This was checked against Postgres; it happens with or
 * without relations on the model.
 *
 * `update({ where: { <unique>, ...guard } })` puts the filter on the UPDATE
 * statement itself (`… WHERE id IN (…) AND <guard>`). Postgres re-checks the
 * filter against the committed row after the lock wait, so the loser
 * matches 0 rows and Prisma throws P2025 ("record not found"). P2025 is
 * raised by the client, not by Postgres, so the surrounding interactive
 * transaction stays usable after it is caught here.
 *
 * Prisma still logs every P2025 when the client logs "error" (src/server/
 * db.ts does). Read the candidate rows first and call `guardedUpdate` only
 * for rows expected to match, so a P2025 (and its log line) only happens
 * when another transaction really got there first.
 */

/** True for Prisma's "record to update/delete not found" error (P2025). */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}

/**
 * Runs a guarded single-row `update` (or `delete`) and returns its result,
 * or `null` when the guard did not match (the row is missing or no longer in
 * the expected state). Every other error is rethrown.
 *
 *   const row = await guardedUpdate(() =>
 *     tx.template.update({
 *       where: { id, companyId, status: "PENDING" },
 *       data: { status: "CANCELLED" },
 *     }),
 *   );
 *   if (row === null) { … not applied … }
 */
export async function guardedUpdate<T>(
  write: () => Promise<T>,
): Promise<T | null> {
  try {
    return await write();
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}
