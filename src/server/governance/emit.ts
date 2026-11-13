import "server-only";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "governance-emit" });

/**
 * Emits jobs AFTER the caller's transaction has committed (03-governance.md
 * G9, H2). The committed state is the truth: a failed emit must not turn a
 * recorded vote, a sent resolution or a withdrawal into an error for the
 * caller (a retry would then be refused as "already recorded" / "closed").
 * The failure is logged and the work is recovered later:
 * - finalize: the sweep re-emits it for every closed resolution whose
 *   `resultNotifiedAt` is still null a few minutes after it closed;
 * - ballot invites: `resolution.remind` re-queues invites of ballots that
 *   were never invited;
 * - notices: `resolution.resendNotice`.
 * Returns false when the emit failed.
 */
export async function emitAfterCommit(
  what: string,
  context: Record<string, string | number | null>,
  emit: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await emit();
    return true;
  } catch (err) {
    log.error({ err, ...context }, `Failed to emit ${what} after commit`);
    return false;
  }
}
