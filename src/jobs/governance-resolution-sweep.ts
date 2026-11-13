import { z } from "zod";
import {
  daysBetween,
  GOVERNANCE_TIME_ZONE,
  todayInZone,
} from "@/lib/governance/dates";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";
import { evaluateAndTransition } from "@/server/governance/tally";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";
import {
  type BallotEmailJobData,
  emitBallotEmails,
} from "./governance-ballot-email";
import { emitResolutionFinalize } from "./governance-resolution-finalize";

// Scheduled resolution sweep (03-governance.md G8), every 15 minutes.
// 1. Closes each SENT resolution whose response period has ended, one
//    transaction per resolution, system actor; finalize is emitted after each
//    commit. evaluateAndTransition locks and re-checks the status, so a
//    resolution already closed (by a read or a previous run) is a no-op.
// 2. Automatic reminders 7 and 2 days before the deadline. Each is keyed
//    "auto-7" / "auto-2"; the email job's dedupe event makes it once only.
// Closing does not depend on this job alone: reads close overdue resolutions
// too (A7).

const JOB_NAME = "governance.resolution-sweep";
const AUTO_REMINDER_DAYS = [7, 2] as const;

const log = logger.child({ module: "governance-resolution-sweep" });

const config = defineWorkerConfig({
  name: JOB_NAME,
  schema: z.object({}),
});

export const resolutionSweepJob = defineJob(config);

async function closeOverdueResolutions(now: Date): Promise<number> {
  const due = await db.resolution.findMany({
    where: { status: "SENT", closesAt: { lt: now } },
    select: { id: true },
    orderBy: { closesAt: "asc" },
  });
  let failures = 0;
  for (const { id } of due) {
    try {
      const transition = await db.$transaction(
        (tx) =>
          evaluateAndTransition(tx, id, now, {
            type: "system",
            id: null,
            ip: "system",
            userAgent: `job:${JOB_NAME}`,
          }),
        { maxWait: 10_000, timeout: 30_000 },
      );
      if (transition) await emitResolutionFinalize(transition.resolutionId);
    } catch (err) {
      failures++;
      log.error({ err, resolutionId: id }, "Failed to close resolution");
    }
  }
  return failures;
}

async function emitAutoReminders(now: Date): Promise<void> {
  const open = await db.resolution.findMany({
    where: { status: "SENT", autoReminders: true, closesAt: { gt: now } },
    select: {
      id: true,
      closesAt: true,
      company: { select: { timezone: true } },
    },
  });
  for (const r of open) {
    if (r.closesAt === null) continue;
    const zone = r.company.timezone || GOVERNANCE_TIME_ZONE;
    const left = daysBetween(
      todayInZone(now, zone),
      todayInZone(r.closesAt, zone),
    );
    if (!(AUTO_REMINDER_DAYS as readonly number[]).includes(left)) continue;

    const marker = `:REMINDER:auto-${left}:`;
    const sent = await db.resolutionEvent.findMany({
      where: { resolutionId: r.id, dedupeKey: { contains: marker } },
      select: { ballotId: true },
    });
    const done = new Set(sent.flatMap((e) => (e.ballotId ? [e.ballotId] : [])));
    const ballots = await db.resolutionBallot.findMany({
      where: {
        resolutionId: r.id,
        submittedAt: null,
        tokenRevokedAt: null,
        invitedAt: { not: null },
      },
      select: { id: true },
    });
    const items: BallotEmailJobData[] = ballots
      .filter((b) => !done.has(b.id))
      .map((b) => ({ ballotId: b.id, kind: "REMINDER", seq: `auto-${left}` }));
    await emitBallotEmails(items);
  }
}

export const resolutionSweepWorker = defineWorker(config, async () => {
  const now = new Date();
  const failures = await closeOverdueResolutions(now);
  await emitAutoReminders(now);
  if (failures > 0) {
    // Retried by pg-boss; already-closed resolutions are skipped.
    throw new Error(`${failures} overdue resolution(s) could not be closed`);
  }
});
