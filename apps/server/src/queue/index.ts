/**
 * Job queues (BullMQ on Redis).
 *
 * Two queues, both consumed by the long-lived worker (BUILD_PLAN step 10):
 *   runs     — one job = one agent turn end-to-end
 *   babysit  — recurring sweep of open PRs (CI status, comments, conflicts)
 */
import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

export interface RunJobData {
  runId: string;
}

export interface BabysitJobData {
  /** Omit to sweep every open thread (the cron's mode). */
  threadId?: string;
}

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createQueueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export interface Queues {
  runs: Queue<RunJobData>;
  babysit: Queue<BabysitJobData>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis, options: { prefix?: string } = {}): Queues {
  const runs = new Queue<RunJobData>("runs", { connection, ...options });
  const babysit = new Queue<BabysitJobData>("babysit", { connection, ...options });
  return {
    runs,
    babysit,
    async close() {
      await Promise.all([runs.close(), babysit.close()]);
      connection.disconnect();
    },
  };
}

/**
 * Retry policy for run jobs: 3 attempts with exponential backoff. Failed runs
 * are evidence — we keep their job records (removeOnFail: false) for the trace.
 */
export const RUN_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: false,
};

/** The babysit timer: every 10 minutes, sweep all open threads. */
export const BABYSIT_REPEAT_MS = 10 * 60 * 1000;
