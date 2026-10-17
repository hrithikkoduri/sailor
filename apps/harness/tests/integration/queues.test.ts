/**
 * Integration tests — need the real stack running: `docker compose up -d`.
 * Run with: npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createQueueConnection, createQueues, type Queues, type RunJobData } from "../../src/queue/index.js";
import { loadConfig } from "../../src/config.js";

describe("queues", () => {
  let queues: Queues;
  let workerConnection: Redis;

  beforeAll(() => {
    const url = loadConfig().redis.url;
    queues = createQueues(createQueueConnection(url));
    workerConnection = createQueueConnection(url);
  });

  afterAll(async () => {
    await queues.close();
    workerConnection.disconnect();
  });

  it("enqueues a run job and a worker picks it up", async () => {
    // Leftovers from other test files (wakeThread adds real jobs) must not
    // pollute the assertion.
    await queues.runs.drain();
    const received: RunJobData[] = [];
    const runId = `test-run-${Date.now()}`;

    // Workers need their own connection (blocking commands), separate from the queue's.
    const worker = new Worker<RunJobData>(
      "runs",
      async (job) => {
        if (job.data.runId === runId) received.push(job.data);
      },
      { connection: workerConnection },
    );

    try {
      await queues.runs.add("run", { runId }, { removeOnComplete: true, removeOnFail: true });

      // Wait for the worker to pick the job up (sub-second normally).
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(received).toEqual([{ runId }]);
    } finally {
      await worker.close();
    }
  });
});
