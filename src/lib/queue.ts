import {
  type Job,
  type JobInsert,
  PgBoss,
  type Queue,
  type QueuePolicy,
  type SendOptions,
  type WorkHandler,
} from "pg-boss";
import type { z } from "zod";
import type { JOB_TYPES } from "@/constants/job";
import { logger } from "@/lib/logger";
import { singleton } from "@/lib/singleton";

const CONNECTION_URL =
  process.env.QUEUE_DATABASE_URL ?? (process.env.DATABASE_URL as string);

/**
 * pg-boss >= 11 cannot migrate a v10 schema (`captable_queue`, schema
 * version 24), so the queue lives in a fresh schema. Pending jobs left in the
 * old schema can be moved with `scripts/move-pgboss-v10-jobs.mjs`.
 */
const QUEUE_SCHEMA = "captable_jobs";

const TWO_DAYS_IN_SECONDS = 60 * 60 * 24 * 2;

// Retry and retention settings are per queue since pg-boss 11.
const QUEUE_OPTIONS = {
  retryBackoff: true,
  retryLimit: 4,
  // Archive tables were removed in pg-boss 11: completed jobs now stay in the
  // job table until they are deleted.
  deleteAfterSeconds: TWO_DAYS_IN_SECONDS,
  // Jobs that are never picked up expire after this.
  retentionSeconds: TWO_DAYS_IN_SECONDS,
} satisfies Omit<Queue, "name">;

const queue = singleton(
  "pg-boss",
  () =>
    new PgBoss({
      connectionString: CONNECTION_URL,
      max: 5,
      schema: QUEUE_SCHEMA,
    }),
);

type JobTypes = typeof JOB_TYPES;

const log = logger.child({ module: "queue" });
const logPrefix = (msg: string) => `[Queue] ${msg}`;

export type JobType = {
  [Key in keyof JobTypes]: `${Key}.${JobTypes[Key][number]}`;
}[keyof JobTypes];

interface WorkerFactory {
  name: JobType;
  // biome-ignore lint/suspicious/noExplicitAny: handler payload type varies per queue
  handler: WorkHandler<any>;
  /** pg-boss queue policy; unset keeps pg-boss's default (`standard`). */
  policy?: QueuePolicy;
}

/**
 * Creates the queue with its policy, or reports a mismatch. pg-boss applies a
 * policy only at creation (`updateQueue` refuses a `policy` and `createQueue`
 * is a no-op for an existing queue), and deleting a queue deletes its jobs, so
 * an existing queue with another policy is left as it is and logged: an
 * operator can delete it while it is empty and restart to apply the policy.
 * Queues without a policy are created exactly as before.
 */
async function ensureQueue(name: string, policy: QueuePolicy | undefined) {
  if (policy === undefined) {
    await queue.createQueue(name, QUEUE_OPTIONS);
    return;
  }
  const existing = await queue.getQueue(name);
  if (existing === null) {
    await queue.createQueue(name, { ...QUEUE_OPTIONS, policy });
    return;
  }
  const current = existing.policy ?? "standard";
  if (current !== policy) {
    log.warn(
      { queue: name, current, wanted: policy },
      logPrefix(
        `Queue ${name} exists with policy "${current}", not "${policy}". Delete it while it has no pending jobs and restart to apply the policy.`,
      ),
    );
  }
}

interface ScheduleFactory {
  name: JobType;
  cron: string;
  tz?: string;
}

function createQueue() {
  const jobs = new Map<string, WorkerFactory>();
  const schedules: ScheduleFactory[] = [];

  async function start() {
    log.info(logPrefix("Starting queue manager"));

    queue.on("error", (error) => {
      log.error({ type: "queue", err: error }, logPrefix("error"));
    });

    await queue.start();

    for (const [jobName, job] of jobs.entries()) {
      log.info(logPrefix(`Registering job:${jobName}`));

      // createQueue() is a no-op for an existing queue, so apply the options
      // explicitly to keep existing queues in sync with QUEUE_OPTIONS (the
      // policy cannot be updated; see ensureQueue).
      await ensureQueue(jobName, job.policy);
      await queue.updateQueue(jobName, QUEUE_OPTIONS);
      await queue.work(jobName, job.handler);
    }

    // Queues must exist before pg-boss can schedule onto them.
    for (const item of schedules) {
      if (!jobs.has(item.name)) {
        throw new Error(`Cannot schedule unregistered job ${item.name}`);
      }
      log.info(logPrefix(`Scheduling job:${item.name} (${item.cron})`));
      await queue.schedule(
        item.name,
        item.cron,
        {},
        { tz: item.tz ?? "UTC", missed: "once" },
      );
    }
  }

  function register(jobFactory: WorkerFactory) {
    jobs.set(jobFactory.name, jobFactory);
  }

  function schedule(factory: ScheduleFactory) {
    schedules.push(factory);
  }

  return { start, register, schedule };
}

const queueManager = createQueue();

function defineWorker<
  U extends ReturnType<typeof defineWorkerConfig>,
  T extends U["schema"],
  V,
>(config: U, handler: (data: Job<z.infer<T>>) => Promise<V>) {
  return {
    name: config.name,
    policy: config.policy,
    handler: ([job]: Job<z.infer<T>>[]) => {
      if (!job) {
        throw new Error("");
      }

      return handler(job);
    },
  };
}

function defineJob<U extends ReturnType<typeof defineWorkerConfig>>(config: U) {
  type TSchema = U["schema"];
  return {
    emit: (data: z.infer<TSchema>, options?: SendOptions) => {
      const data_ = config.schema.parse(data);

      return queue.send(config.name, data_, options ?? {});
    },
    bulkEmit: (data: JobInsert<z.infer<TSchema>>[]) => {
      for (const item of data) {
        config.schema.parse(item.data);
      }

      return queue.insert(config.name, data);
    },
  };
}

interface defineWorkerConfigOptions<T> {
  schema: T;
  name: JobType;
  /**
   * pg-boss queue policy, applied when the queue is created. `singletonKey`
   * only de-duplicates under a policy other than `standard`: `stately`
   * allows one job per key in each of created / retry / active, so a
   * duplicate emit while one is waiting is dropped. No policy de-duplicates
   * after a job completed: a job that must have an effect at most once still
   * claims its own dedupe key (see the governance email jobs).
   */
  policy?: QueuePolicy;
}

// biome-ignore lint/suspicious/noExplicitAny: schema generic is erased for heterogeneous worker configs
function defineWorkerConfig<T extends z.ZodObject<any>>(
  opts: defineWorkerConfigOptions<T>,
) {
  return opts;
}

export { defineJob, defineWorker, defineWorkerConfig, queue, queueManager };
