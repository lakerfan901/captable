#!/usr/bin/env node
// One-off helper for the pg-boss 10 -> 12 upgrade.
//
// pg-boss >= 11 cannot migrate a v10 schema, so the app now uses a new schema
// (`captable_jobs`, see src/lib/queue.ts). This script copies the jobs that
// were still waiting (state `created` or `retry`) in the old `captable_queue`
// schema into the new one, then marks them `cancelled` in the old schema so a
// second run copies nothing. Completed, failed and active jobs are left alone.
//
// Usage (from a checkout with node_modules, against the target database):
//   node scripts/move-pgboss-v10-jobs.mjs            # dry run
//   node scripts/move-pgboss-v10-jobs.mjs --apply
//
// The connection string is read from QUEUE_DATABASE_URL or DATABASE_URL (a
// `.env` file in the working directory is loaded when present). Once the old
// schema holds nothing you need, it can be dropped:
//   DROP SCHEMA captable_queue CASCADE;
import pg from "pg";
import { PgBoss } from "pg-boss";

const OLD_SCHEMA = "captable_queue";
const NEW_SCHEMA = "captable_jobs";
const apply = process.argv.includes("--apply");

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the environment.
}

const connectionString =
  process.env.QUEUE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("Set QUEUE_DATABASE_URL or DATABASE_URL");
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const { rows: oldVersion } = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'job'",
    [OLD_SCHEMA],
  );
  if (oldVersion.length === 0) {
    console.log(`No "${OLD_SCHEMA}" schema found, nothing to move.`);
    process.exit(0);
  }

  const { rows: jobs } = await client.query(
    `SELECT id, name, data, priority, start_after, singleton_key,
            retry_limit, retry_delay, retry_backoff
       FROM ${OLD_SCHEMA}.job
      WHERE state IN ('created', 'retry') AND name NOT LIKE '\\_\\_pgboss\\_\\_%'
      ORDER BY created_on`,
  );

  const byQueue = Map.groupBy(jobs, (job) => job.name);
  for (const [name, list] of byQueue) {
    console.log(`${name}: ${list.length} pending job(s)`);
  }
  if (jobs.length === 0) {
    console.log("No pending jobs to move.");
    process.exit(0);
  }
  if (!apply) {
    console.log("Dry run. Re-run with --apply to move them.");
    process.exit(0);
  }

  // Only install the new schema if needed; no maintenance or cron.
  const boss = new PgBoss({
    connectionString,
    schema: NEW_SCHEMA,
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (error) => console.error(error));
  await boss.start();

  try {
    for (const [name, list] of byQueue) {
      // No-op when the app already created the queue (it then applies the
      // retry/retention options itself on start).
      await boss.createQueue(name);
      await boss.insert(
        name,
        list.map((job) => ({
          data: job.data ?? undefined,
          priority: job.priority,
          startAfter: job.start_after,
          singletonKey: job.singleton_key ?? undefined,
          retryLimit: job.retry_limit,
          retryDelay: job.retry_delay,
          retryBackoff: job.retry_backoff,
        })),
      );
      await client.query(
        `UPDATE ${OLD_SCHEMA}.job
            SET state = 'cancelled', completed_on = now()
          WHERE name = $1 AND id = ANY($2::uuid[])`,
        [name, list.map((job) => job.id)],
      );
      console.log(`${name}: moved ${list.length} job(s) to "${NEW_SCHEMA}"`);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
} finally {
  await client.end();
}
