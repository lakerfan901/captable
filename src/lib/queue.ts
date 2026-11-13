import {
  type Job,
  type JobInsert,
  PgBoss,
  type Queue,
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
      // explicitly to keep existing queues in sync with QUEUE_OPTIONS.
      await queue.createQueue(jobName, QUEUE_OPTIONS);
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
}

// biome-ignore lint/suspicious/noExplicitAny: schema generic is erased for heterogeneous worker configs
function defineWorkerConfig<T extends z.ZodObject<any>>(
  opts: defineWorkerConfigOptions<T>,
) {
  return opts;
}

export { defineJob, defineWorker, defineWorkerConfig, queue, queueManager };
